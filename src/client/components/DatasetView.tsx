// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { shortSyntax } from "ts-proppy/react";
import type {
  Dataset,
  DatasetRow,
  ExecutionInput,
  NormalizedPrompt,
  PromptID,
} from "../../shared/types";
import {
  deleteDataset,
  deleteDatasetRow,
  getDataset,
  renameDataset,
} from "../api";
import {
  objectCellLines,
  previewArgs,
  previewCell,
  resourceName,
} from "./dataset-preview";
import {
  fromRow,
  type PanelFill,
  panelFill,
  staleFields,
} from "./named-inputs";
import { formatTimestamp, formatTimestampCompact } from "./trace/format.ts";
import {
  CalendarIcon,
  DatasetsIcon,
  MoreIcon,
  PromptLinkIcon,
  TrashIcon,
} from "./trace/icons.tsx";
import { useAnchoredPopover } from "./use-anchored-popover";

interface Props {
  providerId: string;
  datasetId: string;
  /**
   * Bumped whenever this dataset changes on the server (a `dataset-changed`
   * event), so the view refetches.
   */
  version: number;
  /** Looks up the prompt a (resolved) prompt reference names, if loaded. */
  findPrompt: (prompt: PromptID) => NormalizedPrompt | undefined;
  /** Opens `prompt` in a split pane, as it is. */
  onOpenPrompt: (prompt: NormalizedPrompt) => void;
  /** Opens `prompt` in a split pane with its execute panel filled. */
  onOpenInPlayground: (prompt: NormalizedPrompt, fill: PanelFill) => void;
  /** Opens a row's source trace. */
  onOpenTrace: (providerId: string, traceId: string) => void;
  /** Called after the dataset itself has been deleted. */
  onDeleted: () => void;
}

/** One cell of the table. */
function Cell({ input }: { input: ExecutionInput | undefined }) {
  if (!input) return <span className="dataset-cell-empty">—</span>;
  switch (input.kind) {
    case "resource": {
      const args = previewArgs(input.args);
      return (
        <span className="dataset-cell-chip" title={input.uri}>
          <span className="dataset-cell-chip-icon" aria-hidden>
            ◆
          </span>
          {resourceName(input.uri)}
          {args && <span className="dataset-cell-args">({args})</span>}
        </span>
      );
    }
    case "object":
      return (
        <span className="dataset-cell-object">
          {"{…}"}
          <span className="dataset-cell-expand" role="tooltip">
            {objectCellLines(input).map(line => (
              <span key={line.key} className="dataset-cell-expand-line">
                <span className="dataset-cell-expand-key">{line.key}:</span>{" "}
                {line.preview}
              </span>
            ))}
          </span>
        </span>
      );
    default:
      return <span className="dataset-cell-value">{previewCell(input)}</span>;
  }
}

/**
 * A dataset's rows, as a table: view, delete, and — when the dataset is
 * linked to a prompt that's loaded — open a row in the playground with the
 * execute panel filled. No in-table editing in v1. See `specs/datasets.md` §J.
 */
function DatasetView({
  providerId,
  datasetId,
  version,
  findPrompt,
  onOpenPrompt,
  onOpenInPlayground,
  onOpenTrace,
  onDeleted,
}: Props) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [rows, setRows] = useState<DatasetRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const {
    triggerRef: menuTriggerRef,
    popoverRef: menuRef,
    style: menuStyle,
  } = useAnchoredPopover<HTMLButtonElement>({
    open: menuOpen,
    onClose: closeMenu,
    matchTriggerWidth: false,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the refetch signal.
  useEffect(() => {
    let cancelled = false;
    getDataset(providerId, datasetId)
      .then(data => {
        if (cancelled) return;
        setDataset(data.dataset);
        setRows(data.rows);
        setError(null);
      })
      .catch(err => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [providerId, datasetId, version]);

  const act = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (error && !dataset) {
    return (
      <div className="dataset-view dataset-view-error">Error: {error}</div>
    );
  }
  if (!dataset) {
    return (
      <div className="dataset-view">
        <div className="trace-view-loading">Loading dataset…</div>
      </div>
    );
  }

  const linkedPrompt = dataset.prompt ? findPrompt(dataset.prompt) : undefined;
  const stale = linkedPrompt ? staleFields(dataset.fields, linkedPrompt) : [];

  const submitRename = () =>
    act(async () => {
      const trimmed = name.trim();
      setRenaming(false);
      if (!trimmed || trimmed === dataset.name) return;
      setDataset(await renameDataset(providerId, datasetId, trimmed));
    });

  const startRename = () => {
    setName(dataset.name);
    setRenaming(true);
  };

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete “${dataset.name}” and its ${rows.length} row${rows.length === 1 ? "" : "s"}?`,
      )
    )
      return;
    void act(async () => {
      await deleteDataset(providerId, datasetId);
      onDeleted();
    });
  };

  const menu =
    menuOpen &&
    createPortal(
      <div className="trace-header-menu" ref={menuRef} style={menuStyle}>
        <button
          type="button"
          className="trace-header-menu-item dataset-menu-delete"
          onClick={() => {
            setMenuOpen(false);
            handleDelete();
          }}
        >
          <span className="trace-header-menu-item-label">Delete dataset</span>
        </button>
      </div>,
      document.body,
    );

  return (
    <div className="dataset-view">
      <div className="trace-view-header dataset-view-header">
        <div className="trace-view-header-row">
          <div className="trace-view-title">
            {renaming ? (
              <form
                className="dataset-view-rename"
                onSubmit={e => {
                  e.preventDefault();
                  void submitRename();
                }}
              >
                <input
                  autoFocus
                  aria-label="Dataset name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onFocus={e => e.target.select()}
                  onBlur={() => setRenaming(false)}
                  onKeyDown={e => e.key === "Escape" && setRenaming(false)}
                />
              </form>
            ) : (
              <span
                className="trace-view-name"
                onDoubleClick={startRename}
                title="Double-click to rename"
              >
                {dataset.name}
              </span>
            )}
          </div>
          <div className="trace-view-header-actions">
            <div className="trace-view-header-actions-full">
              <button
                type="button"
                className="trace-view-prompt-btn trace-view-delete-btn"
                onClick={handleDelete}
                title="Delete dataset"
                aria-label="Delete dataset"
              >
                <TrashIcon />
              </button>
            </div>
            <button
              type="button"
              ref={menuTriggerRef}
              className="trace-view-header-menu-trigger"
              onClick={() => setMenuOpen(o => !o)}
              title="More actions"
              aria-label="More actions"
            >
              <MoreIcon />
            </button>
          </div>
        </div>
        <div className="trace-view-meta">
          <span className="trace-view-meta-item" title="Last updated">
            <CalendarIcon />
            <span className="trace-view-date-full">
              {formatTimestamp(dataset.updatedAt)}
            </span>
            <span className="trace-view-date-compact">
              {formatTimestampCompact(dataset.updatedAt)}
            </span>
          </span>
          <span className="trace-view-meta-item" title="Row count">
            <DatasetsIcon />
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
          {linkedPrompt && (
            <button
              type="button"
              className="trace-view-meta-item trace-view-prompt-link"
              onClick={() => onOpenPrompt(linkedPrompt)}
              title="Open the linked prompt"
            >
              <PromptLinkIcon />
              <span className="trace-view-prompt-link-name">
                {linkedPrompt.name}
              </span>
              ↗
            </button>
          )}
        </div>
      </div>
      {menu}
      {error && (
        <div className="pg-exec-error dataset-view-action-error">
          {error}
          <button
            type="button"
            className="pg-dismiss"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      )}
      {linkedPrompt && stale.length > 0 && (
        <div className="dataset-view-stale">
          {stale.length} field{stale.length === 1 ? "" : "s"} no longer match{" "}
          <code>{linkedPrompt.name}</code>'s parameters:{" "}
          {stale.map((f, i) => (
            <span key={f.id}>
              {i > 0 && ", "}
              <code>{f.def.name}</code>
            </span>
          ))}
        </div>
      )}
      <div className="dataset-view-body">
        {rows.length === 0 ? (
          <div className="tree-empty-state">
            <p>No rows yet.</p>
          </div>
        ) : (
          <table className="dataset-table">
            <thead>
              <tr>
                <th className="dataset-table-index">#</th>
                {dataset.fields.map(field => (
                  <th key={field.id}>
                    <span className="dataset-table-field">
                      {field.def.name}
                    </span>
                    <span
                      className="dataset-table-type"
                      title={field.def.type.syntax}
                    >
                      {shortSyntax(field.def.type.syntax, 24)}
                    </span>
                  </th>
                ))}
                <th>source</th>
                <th className="dataset-table-actions-th" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.id}>
                  <td className="dataset-table-index">{index + 1}</td>
                  {dataset.fields.map(field => (
                    <td key={field.id}>
                      <Cell input={row.cells[field.id]} />
                    </td>
                  ))}
                  <td className="dataset-table-source">
                    {row.source?.kind === "trace" ? (
                      <button
                        type="button"
                        className="dataset-link-btn"
                        onClick={() => {
                          const source = row.source;
                          if (source?.kind === "trace")
                            onOpenTrace(source.traceProviderId, source.traceId);
                        }}
                        title="Open the trace this row came from"
                      >
                        trace ↗
                      </button>
                    ) : row.source?.kind === "playground" ? (
                      "playground"
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="dataset-table-actions">
                    {linkedPrompt && (
                      <button
                        type="button"
                        className="dataset-row-btn"
                        title={`Open in playground (${linkedPrompt.name})`}
                        aria-label={`Open row ${index + 1} in playground`}
                        onClick={() =>
                          onOpenInPlayground(
                            linkedPrompt,
                            panelFill(fromRow(dataset, row), linkedPrompt, {
                              type: "dataset",
                              description: `${dataset.name}, row ${index + 1}`,
                              providerId,
                              datasetId,
                              name: dataset.name,
                            }),
                          )
                        }
                      >
                        ▶
                      </button>
                    )}
                    <button
                      type="button"
                      className="dataset-row-btn dataset-row-delete"
                      title="Delete row"
                      aria-label={`Delete row ${index + 1}`}
                      onClick={() =>
                        void act(async () => {
                          await deleteDatasetRow(providerId, datasetId, row.id);
                          setRows(prev => prev.filter(r => r.id !== row.id));
                        })
                      }
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default DatasetView;
