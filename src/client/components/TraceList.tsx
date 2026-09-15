// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AnnotationKind, TraceSummary } from "../../shared/types";
import { KIND_STYLES } from "./trace/AnnotationChip.tsx";
import {
  formatCost,
  formatDuration,
  formatTimestampCompact,
  formatTokenCount,
} from "./trace/format.ts";
import {
  AnnotationsIcon,
  CalendarIcon,
  CostIcon,
  ModelIcon,
  SpansIcon,
  StopwatchIcon,
  TokensIcon,
} from "./trace/icons.tsx";
import {
  DEFAULT_TRACE_COLUMNS,
  parseTraceColumns,
  reorderTraceColumns,
  type TraceColumnKey,
  type TraceColumnState,
  tableModeWidth,
  toggleTraceColumn,
} from "./trace-columns";
import { useAnchoredPopover } from "./use-anchored-popover";

/** How many of the visible, ordered columns the narrow (card) layout's meta row shows. */
const CARD_META_COLUMN_COUNT = 3;

const COLUMN_STORAGE_KEY = "trace-list-columns";

function loadColumnState(): TraceColumnState[] {
  try {
    const stored = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (stored) return parseTraceColumns(JSON.parse(stored));
  } catch {
    /* ignore */
  }
  return DEFAULT_TRACE_COLUMNS;
}

const COLUMN_LABELS: Record<TraceColumnKey, string> = {
  startTime: "Date",
  spanCount: "Spans",
  duration: "Duration",
  totalTokens: "Tokens",
  model: "Model",
  cost: "Cost",
  annotations: "Annotations",
};

/** Columns the wide (table) layout can sort by — every column except `annotations`, whose three counts don't collapse into one sortable value. */
type SortKey = Exclude<TraceColumnKey, "annotations"> | "name";

function columnIcon(key: TraceColumnKey) {
  switch (key) {
    case "startTime":
      return <CalendarIcon />;
    case "spanCount":
      return <SpansIcon />;
    case "duration":
      return <StopwatchIcon />;
    case "totalTokens":
      return <TokensIcon />;
    case "model":
      return <ModelIcon />;
    case "cost":
      return <CostIcon />;
    case "annotations":
      return <AnnotationsIcon />;
  }
}

const ANNOTATION_KINDS: AnnotationKind[] = ["issue", "good", "note"];

/** Small colored count-pills, one per nonzero annotation kind — empty renders as "—". Reuses `.annotation-chip-*` (`AnnotationChip.tsx`) so a count reads with the same color as the chip on the trace itself. */
function AnnotationCountBadges({
  counts,
}: {
  counts: TraceSummary["annotationCounts"];
}) {
  const nonzero = ANNOTATION_KINDS.filter(kind => counts[kind] > 0);
  if (nonzero.length === 0) {
    return <span className="trace-annotation-counts-empty">—</span>;
  }
  return (
    <span className="trace-annotation-counts">
      {nonzero.map(kind => (
        <span key={kind} className={`annotation-chip annotation-chip-${kind}`}>
          <span className="annotation-chip-icon">{KIND_STYLES[kind].icon}</span>
          {counts[kind]}
        </span>
      ))}
    </span>
  );
}

/** This column's value for `trace`, formatted for the table (a bare span count, no "spans" word). */
function columnTableText(
  trace: TraceSummary,
  key: TraceColumnKey,
): React.ReactNode {
  switch (key) {
    case "startTime":
      return formatTimestampCompact(trace.startTime);
    case "spanCount":
      return trace.spanCount;
    case "duration": {
      const duration = traceDuration(trace);
      return duration !== undefined ? formatDuration(duration) : "running…";
    }
    case "totalTokens":
      return trace.totalTokens !== undefined
        ? formatTokenCount(trace.totalTokens)
        : "—";
    case "model":
      return trace.model ?? "—";
    case "cost":
      return trace.cost !== undefined ? formatCost(trace.cost) : "—";
    case "annotations":
      return <AnnotationCountBadges counts={trace.annotationCounts} />;
  }
}

/** This column's value for `trace`, formatted for a card's meta row (e.g. "8 spans"). */
function columnCardText(
  trace: TraceSummary,
  key: TraceColumnKey,
): React.ReactNode {
  if (key === "spanCount") {
    return `${trace.spanCount} span${trace.spanCount === 1 ? "" : "s"}`;
  }
  return columnTableText(trace, key);
}

interface TraceListProps {
  traces: TraceSummary[];
  loading: boolean;
  error: string | null;
  selectedTraceKey: string | null;
  onSelect: (trace: TraceSummary) => void;
  /** The sidebar's current width, in px — read by the table-mode toggle to know what to restore. */
  sidebarWidth: number;
  /** Resizes the sidebar — how the table-mode toggle widens it and restores it. */
  onResizeSidebar: (width: number) => void;
}

const traceKey = (t: { providerId: string; id: string }) =>
  `${t.providerId}:${t.id}`;

/** A trace's running duration, or `undefined` while it's still in flight. */
function traceDuration(t: TraceSummary): number | undefined {
  return t.endTime !== undefined ? t.endTime - t.startTime : undefined;
}

interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

function sortValue(t: TraceSummary, key: SortKey): number | string | undefined {
  switch (key) {
    case "name":
      return t.name;
    case "startTime":
      return t.startTime;
    case "spanCount":
      return t.spanCount;
    case "duration":
      return traceDuration(t);
    case "totalTokens":
      return t.totalTokens;
    case "model":
      return t.model;
    case "cost":
      return t.cost;
  }
}

/** A trace still running (`undefined` duration) always sorts last, regardless of direction. */
function sortTraces(traces: TraceSummary[], sort: SortState): TraceSummary[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...traces].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    if (typeof av === "string" || typeof bv === "string") {
      return (av as string).localeCompare(bv as string) * sign;
    }
    if (av === undefined) return bv === undefined ? 0 : 1;
    if (bv === undefined) return -1;
    return (av - bv) * sign;
  });
}

function SortableHeader({
  label,
  icon,
  sortKey,
  sort,
  onSort,
  className = "trace-table-th",
}: {
  label: string;
  icon?: React.ReactNode;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={className}
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className={`trace-table-sort-btn${active ? " trace-table-sort-btn-active" : ""}`}
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
      >
        {icon ?? label}
        <span className="trace-table-sort-arrow" aria-hidden>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

/** Two horizontal arrows, stacked and pointing opposite ways — the table-mode toggle. */
function TableModeIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="2" y1="7" x2="18" y2="7" />
      <polyline points="14 3 18 7 14 11" />
      <line x1="22" y1="17" x2="6" y2="17" />
      <polyline points="10 13 6 17 10 21" />
    </svg>
  );
}

function ColumnsIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  );
}

/** A 2×3 grid of dots — the column picker's drag-to-reorder grab handle. */
function GrabHandleIcon() {
  return (
    <svg
      width="10"
      height="16"
      viewBox="0 0 10 16"
      fill="currentColor"
      aria-hidden
    >
      <circle cx="3" cy="3" r="1.3" />
      <circle cx="7" cy="3" r="1.3" />
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="7" cy="8" r="1.3" />
      <circle cx="3" cy="13" r="1.3" />
      <circle cx="7" cy="13" r="1.3" />
    </svg>
  );
}

/**
 * Trigger + popover for showing/hiding and reordering {@link TraceColumnState}s.
 * Reordering is native HTML5 drag-and-drop off each row's grab handle: the
 * dragged row's index tracks live in `dragIndex`, and dragging over another
 * row reorders immediately (a "live swap" — no separate drop-position math),
 * matching how `Tab.tsx` drags a tab.
 */
function ColumnPickerButton({
  columns,
  onToggle,
  onReorder,
}: {
  columns: TraceColumnState[];
  onToggle: (key: TraceColumnKey) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: () => setOpen(false),
      matchTriggerWidth: false,
    });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`tree-toolbar-btn${open ? " tree-toolbar-btn-active" : ""}`}
        title="Columns"
        onClick={() => setOpen(v => !v)}
      >
        <ColumnsIcon />
      </button>
      {open &&
        createPortal(
          <div className="trace-column-picker" ref={popoverRef} style={style}>
            {columns.map((column, i) => (
              <div
                key={column.key}
                className={`trace-column-picker-row${dragIndex === i ? " trace-column-picker-row-dragging" : ""}`}
                onDragOver={e => {
                  e.preventDefault();
                  if (dragIndex === null || dragIndex === i) return;
                  onReorder(dragIndex, i);
                  setDragIndex(i);
                }}
                onDrop={e => e.preventDefault()}
              >
                <span
                  className="trace-column-picker-grab"
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", column.key);
                    setDragIndex(i);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  title="Drag to reorder"
                >
                  <GrabHandleIcon />
                </span>
                <label className="trace-column-picker-check">
                  <input
                    type="checkbox"
                    checked={column.visible}
                    onChange={() => onToggle(column.key)}
                  />
                  <span className="trace-column-picker-icon">
                    {columnIcon(column.key)}
                  </span>
                  <span>{COLUMN_LABELS[column.key]}</span>
                </label>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function TraceList({
  traces,
  loading,
  error,
  selectedTraceKey,
  onSelect,
  sidebarWidth,
  onResizeSidebar,
}: TraceListProps) {
  const [sort, setSort] = useState<SortState>({
    key: "startTime",
    dir: "desc",
  });
  const [columns, setColumns] = useState<TraceColumnState[]>(loadColumnState);
  // `null` while at its normal width; the width to restore to while expanded
  // for table mode, so the second click can put it back exactly.
  const [savedWidth, setSavedWidth] = useState<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns));
    } catch {
      /* ignore */
    }
  }, [columns]);

  const toggleSort = (key: SortKey) => {
    setSort(prev =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  };

  const toggleTableMode = () => {
    if (savedWidth !== null) {
      onResizeSidebar(savedWidth);
      setSavedWidth(null);
    } else {
      setSavedWidth(sidebarWidth);
      onResizeSidebar(tableModeWidth(columns));
    }
  };

  const header = (
    <div className="section-panel-header">
      <span>Traces</span>
      <div className="section-panel-header-actions">
        <ColumnPickerButton
          columns={columns}
          onToggle={key => setColumns(prev => toggleTraceColumn(prev, key))}
          onReorder={(fromIndex, toIndex) =>
            setColumns(prev => reorderTraceColumns(prev, fromIndex, toIndex))
          }
        />
        <button
          type="button"
          className={`tree-toolbar-btn${savedWidth !== null ? " tree-toolbar-btn-active" : ""}`}
          title="Toggle table view"
          aria-pressed={savedWidth !== null}
          onClick={toggleTableMode}
        >
          <TableModeIcon />
        </button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <>
        {header}
        <div className="section-panel-body">
          <div className="tree-status">Loading...</div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        {header}
        <div className="section-panel-body">
          <div className="tree-status tree-error">Error: {error}</div>
        </div>
      </>
    );
  }

  if (traces.length === 0) {
    return (
      <>
        {header}
        <div className="section-panel-body">
          <div className="tree-empty-state">
            <p>No traces yet.</p>
            <p className="trace-list-hint">Run a prompt to create one.</p>
          </div>
        </div>
      </>
    );
  }

  const sorted = sortTraces(traces, sort);
  const visibleColumns = columns.filter(c => c.visible);
  const cardColumns = visibleColumns.slice(0, CARD_META_COLUMN_COUNT);

  return (
    <>
      {header}
      <div className="section-panel-body trace-list">
        {/* Card layout — the default, and the only one left once the sidebar
            gets too narrow for the table's columns (its meta row disappears
            below that). */}
        <div className="trace-list-cards">
          {sorted.map(trace => {
            const key = traceKey(trace);
            const isSelected = key === selectedTraceKey;
            return (
              <div
                key={key}
                className={`trace-list-row${isSelected ? " trace-list-row-selected" : ""}`}
                onClick={() => onSelect(trace)}
                title={trace.name}
              >
                <div className="trace-list-row-top">
                  <span
                    className={`trace-status-dot trace-status-${trace.status}`}
                  />
                  <span className="trace-list-name">{trace.name}</span>
                </div>
                <div className="trace-list-row-meta">
                  {cardColumns.map(column => (
                    <span key={column.key} className="trace-list-meta-item">
                      {columnIcon(column.key)}
                      {columnCardText(trace, column.key)}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Table layout — shown instead of the cards once the sidebar is
            wide enough for sortable columns. */}
        <table className="trace-table">
          <thead>
            <tr>
              <SortableHeader
                label="Name"
                sortKey="name"
                sort={sort}
                onSort={toggleSort}
                className="trace-table-name-th"
              />
              {visibleColumns.map(column => {
                const className = `trace-table-th trace-table-col-${column.key}`;
                if (column.key === "annotations") {
                  return (
                    <th
                      key={column.key}
                      className={className}
                      title={COLUMN_LABELS[column.key]}
                    >
                      {columnIcon(column.key)}
                    </th>
                  );
                }
                return (
                  <SortableHeader
                    key={column.key}
                    label={COLUMN_LABELS[column.key]}
                    icon={columnIcon(column.key)}
                    sortKey={column.key}
                    sort={sort}
                    onSort={toggleSort}
                    className={className}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map(trace => {
              const key = traceKey(trace);
              const isSelected = key === selectedTraceKey;
              return (
                <tr
                  key={key}
                  className={`trace-table-row${isSelected ? " trace-table-row-selected" : ""}`}
                  onClick={() => onSelect(trace)}
                  title={trace.name}
                >
                  <td className="trace-table-name-cell">
                    <span
                      className={`trace-status-dot trace-status-${trace.status}`}
                    />
                    <span className="trace-list-name">{trace.name}</span>
                  </td>
                  {visibleColumns.map(column => (
                    <td
                      key={column.key}
                      className={`trace-table-col-${column.key}`}
                    >
                      {columnTableText(trace, column.key)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default TraceList;
