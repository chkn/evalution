// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AnnotationKind,
  TraceSummary,
  VariationInfo,
} from "../../shared/types";
import { lookupVariations } from "../api";
import {
  type SummaryColumn,
  SummaryList,
  TableModeButton,
} from "./SummaryList";
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
  VariationIcon,
  VersionIcon,
} from "./trace/icons.tsx";
import {
  DEFAULT_TRACE_COLUMNS,
  parseTraceColumns,
  reorderTraceColumns,
  TRACE_COLUMN_WIDTH_PX,
  type TraceColumnKey,
  type TraceColumnState,
  tableModeWidth,
  toggleTraceColumn,
  traceVariationLabel,
  traceVersionLabel,
} from "./trace-columns";
import { groupTraces, type TraceListItem } from "./trace-groups";
import { useAnchoredPopover } from "./use-anchored-popover";

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
  version: "Version",
  variation: "Variation",
};

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
    case "version":
      return <VersionIcon />;
    case "variation":
      return <VariationIcon />;
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

/** A row's tooltip: a trace's name, or what a group gathers. */
function groupTitle(item: TraceListItem): string {
  const { children } = item;
  if (!children) return item.name;
  const count = `${children.length} ${item.evalRun ? "trace" : "run"}${children.length === 1 ? "" : "s"}`;
  return item.evalRun
    ? `${item.name} — eval run started ${formatTimestampCompact(item.evalRun.startedAt)}, ${count}`
    : `Playground — ${count}`;
}

const traceKey = (t: { providerId: string; id: string }) =>
  `${t.providerId}:${t.id}`;

/** A trace's running duration, or `undefined` while it's still in flight. */
function traceDuration(t: TraceSummary): number | undefined {
  return t.endTime !== undefined ? t.endTime - t.startTime : undefined;
}

/** How each {@link TraceColumnKey} renders and sorts — every column except `annotations` is sortable, since its three counts don't collapse into one value. */
const COLUMN_DEFS: Record<
  Exclude<TraceColumnKey, "version" | "variation">,
  Omit<SummaryColumn<TraceSummary>, "key" | "label" | "icon" | "width">
> = {
  startTime: {
    cell: t => formatTimestampCompact(t.startTime),
    sortValue: t => t.startTime,
  },
  spanCount: {
    // A bare count in the table, where the header says what it counts.
    cell: t => t.spanCount,
    card: t => `${t.spanCount} span${t.spanCount === 1 ? "" : "s"}`,
    sortValue: t => t.spanCount,
  },
  duration: {
    cell: t => {
      const duration = traceDuration(t);
      return duration !== undefined ? formatDuration(duration) : "running…";
    },
    sortValue: traceDuration,
  },
  totalTokens: {
    cell: t =>
      t.totalTokens !== undefined ? formatTokenCount(t.totalTokens) : "—",
    sortValue: t => t.totalTokens,
  },
  model: {
    cell: t => t.model ?? "—",
    sortValue: t => t.model,
  },
  cost: {
    cell: t => (t.cost !== undefined ? formatCost(t.cost) : "—"),
    sortValue: t => t.cost,
  },
  annotations: {
    cell: t => <AnnotationCountBadges counts={t.annotationCounts} />,
  },
};

/**
 * Descriptions of the prompt variations the listed traces ran, looked up only
 * while their column is shown, and only for ids not already known — they are
 * immutable, so nothing ever needs re-fetching.
 */
function useVariationLookups(
  traces: TraceSummary[],
  columns: TraceColumnState[],
) {
  const [variations, setVariations] = useState<Record<string, VariationInfo>>(
    {},
  );
  const showVariations = columns.some(c => c.key === "variation" && c.visible);
  const variationIds = showVariations
    ? [...new Set(traces.flatMap(t => t.promptVariation ?? []))]
        .filter(id => !(id in variations))
        .join(",")
    : "";

  useEffect(() => {
    if (!variationIds) return;
    lookupVariations(variationIds.split(","))
      .then(found => setVariations(prev => ({ ...prev, ...found })))
      .catch(() => {});
  }, [variationIds]);

  return variations;
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
  const [columns, setColumns] = useState<TraceColumnState[]>(loadColumnState);
  const variations = useVariationLookups(traces, columns);
  const items = useMemo(() => groupTraces(traces), [traces]);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns));
    } catch {
      /* ignore */
    }
  }, [columns]);

  const visibleColumns: SummaryColumn<TraceSummary>[] = columns
    .filter(c => c.visible)
    .map(({ key }) => ({
      key,
      label: COLUMN_LABELS[key],
      icon: columnIcon(key),
      width: TRACE_COLUMN_WIDTH_PX[key],
      ...(key === "version"
        ? {
            cell: (t: TraceSummary) => traceVersionLabel(t),
            sortValue: (t: TraceSummary) => t.promptVersion,
          }
        : key === "variation"
          ? {
              cell: (t: TraceSummary) => traceVariationLabel(t, variations),
              sortValue: (t: TraceSummary) =>
                traceVariationLabel(t, variations),
            }
          : COLUMN_DEFS[key]),
    }));

  return (
    <SummaryList<TraceListItem>
      title="Traces"
      headerActions={
        <>
          <ColumnPickerButton
            columns={columns}
            onToggle={key => setColumns(prev => toggleTraceColumn(prev, key))}
            onReorder={(fromIndex, toIndex) =>
              setColumns(prev => reorderTraceColumns(prev, fromIndex, toIndex))
            }
          />
          <TableModeButton
            sidebarWidth={sidebarWidth}
            onResizeSidebar={onResizeSidebar}
            tableWidth={tableModeWidth(columns)}
          />
        </>
      }
      loading={loading}
      error={error}
      empty={
        <>
          <p>No traces yet.</p>
          <p className="trace-list-hint">Run a prompt to create one.</p>
        </>
      }
      items={items}
      columns={visibleColumns}
      itemKey={traceKey}
      itemName={t => t.name}
      itemTitle={groupTitle}
      itemChildren={t => t.children}
      itemMarker={t => (
        <span className={`trace-status-dot trace-status-${t.status}`} />
      )}
      selectedKey={selectedTraceKey}
      onSelect={onSelect}
      defaultSort={{ key: "startTime", dir: "desc" }}
    />
  );
}

export default TraceList;
