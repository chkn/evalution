// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { DatasetSummary, PromptID } from "../../shared/types";
import {
  type SummaryColumn,
  SummaryList,
  TableModeButton,
} from "./SummaryList";
import { tableModeWidth } from "./summary-list";
import { formatTimestampCompact } from "./trace/format.ts";
import { CalendarIcon, DatasetsIcon, PromptLinkIcon } from "./trace/icons.tsx";

interface Props {
  datasets: DatasetSummary[];
  loading: boolean;
  error: string | null;
  /** `${providerId}:${id}` of the dataset open in the focused pane. */
  selectedKey: string | null;
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
 * The sidebar's Datasets section: its row count, linked prompt, and when it
 * last changed — as cards, or a sortable table once the sidebar is wide
 * enough. Shares its layout with `TraceList` via `SummaryList`.
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
        <TableModeButton
          sidebarWidth={sidebarWidth}
          onResizeSidebar={onResizeSidebar}
          tableWidth={tableModeWidth(columns.map(c => c.width))}
        />
      }
      loading={loading}
      error={error}
      empty={
        <>
          <p>No datasets yet.</p>
          <p className="trace-list-hint">
            Use “Add to dataset” in a prompt's execute panel, or on a trace.
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
