// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import type { DatasetSummary, PromptID } from "../../shared/types";
import { createEmptyDataset } from "../api";
import {
  type SummaryColumn,
  SummaryList,
  TableModeButton,
} from "./SummaryList";
import { tableModeWidth } from "./summary-list";
import { formatTimestampCompact } from "./trace/format.ts";
import {
  CalendarIcon,
  DatasetsIcon,
  PlusIcon,
  PromptLinkIcon,
} from "./trace/icons.tsx";
import { useAnchoredPopover } from "./use-anchored-popover";

interface Props {
  datasets: DatasetSummary[];
  loading: boolean;
  error: string | null;
  /** `${providerId}:${id}` of the dataset open in the focused pane. */
  selectedKey: string | null;
  /** Opens a dataset — one clicked in the list, or one just created. */
  onSelect: (dataset: DatasetSummary) => void;
  /** The name of the prompt a dataset is linked to, if it's loaded. */
  promptName: (prompt: PromptID) => string | undefined;
  /** The sidebar's current width, in px — read by the table-mode toggle to know what to restore. */
  sidebarWidth: number;
  /** Resizes the sidebar — how the table-mode toggle widens it and restores it. */
  onResizeSidebar: (width: number) => void;
}

/** The key {@link Props.selectedKey} compares against. */
export function datasetKey(d: { providerId: string; id: string }): string {
  return `${d.providerId}:${d.id}`;
}

/**
 * "New dataset…": asks for a name in a popover, then creates a dataset with
 * that name and nothing else — no fields, no prompt link — to be filled in
 * by hand (`specs/datasets.md` §P.3).
 */
function NewDatasetButton({
  onCreated,
}: {
  onCreated: (dataset: DatasetSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setName("");
    setError(null);
  }, []);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
    });

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const created = await createEmptyDataset(trimmed);
      close();
      onCreated(created);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`tree-toolbar-btn${open ? " tree-toolbar-btn-active" : ""}`}
        title="New dataset…"
        aria-label="New dataset"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <PlusIcon />
      </button>
      {open &&
        createPortal(
          <div className="add-to-dataset-menu" ref={popoverRef} style={style}>
            <form
              className="add-to-dataset-new"
              onSubmit={e => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                autoFocus
                className="add-to-dataset-name"
                placeholder="Dataset name"
                aria-label="New dataset name"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={busy}
              />
              <button
                type="submit"
                className="add-to-dataset-create"
                disabled={busy || !name.trim()}
              >
                Create
              </button>
            </form>
            {error && <div className="add-to-dataset-error">{error}</div>}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The sidebar's Datasets section: its row count, linked prompt, and when it
 * last changed — as cards, or a sortable table once the sidebar is wide
 * enough. Shares its layout with `TraceList` via `SummaryList`. "New
 * dataset…" in its header creates an empty one and opens it.
 */
function DatasetList({
  datasets,
  loading,
  error,
  selectedKey,
  onSelect,
  promptName,
  sidebarWidth,
  onResizeSidebar,
}: Props) {
  const linkedName = (d: DatasetSummary) => d.prompt && promptName(d.prompt);

  const columns: SummaryColumn<DatasetSummary>[] = [
    {
      key: "rowCount",
      label: "Rows",
      icon: <DatasetsIcon />,
      width: 48,
      cell: d =>
        d.error ? (
          <span className="dataset-list-error">error</span>
        ) : (
          d.rowCount
        ),
      card: d =>
        d.error ? (
          <span className="dataset-list-error">can't be opened</span>
        ) : (
          `${d.rowCount} row${d.rowCount === 1 ? "" : "s"}`
        ),
      sortValue: d => (d.error ? undefined : d.rowCount),
    },
    {
      key: "prompt",
      label: "Prompt",
      icon: <PromptLinkIcon />,
      width: 110,
      cell: d => linkedName(d) || "—",
      card: d => linkedName(d) || null,
      sortValue: d => linkedName(d) || undefined,
    },
    {
      key: "updatedAt",
      label: "Updated",
      icon: <CalendarIcon />,
      width: 100,
      cell: d => (d.updatedAt > 0 ? formatTimestampCompact(d.updatedAt) : "—"),
      card: d => (d.updatedAt > 0 ? formatTimestampCompact(d.updatedAt) : null),
      sortValue: d => d.updatedAt,
    },
  ];

  return (
    <SummaryList
      title="Datasets"
      headerActions={
        <>
          <TableModeButton
            sidebarWidth={sidebarWidth}
            onResizeSidebar={onResizeSidebar}
            tableWidth={tableModeWidth(columns.map(c => c.width))}
          />
          <NewDatasetButton onCreated={onSelect} />
        </>
      }
      loading={loading}
      error={error}
      empty={
        <>
          <p>No datasets yet.</p>
          <p className="trace-list-hint">
            Start one by hand with “+” above, or use “Add to dataset” in a
            prompt's execute panel or on a trace.
          </p>
        </>
      }
      items={datasets}
      columns={columns}
      itemKey={datasetKey}
      itemName={d => d.name}
      itemTitle={d => d.error ?? d.name}
      selectedKey={selectedKey}
      onSelect={onSelect}
      defaultSort={{ key: "updatedAt", dir: "desc" }}
    />
  );
}

export default DatasetList;
