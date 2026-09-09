// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { TraceSummary } from "../../shared/types";
import { formatDuration, formatTimestampCompact } from "./trace/format.ts";
import { CalendarIcon, SpansIcon, StopwatchIcon } from "./trace/icons.tsx";

interface TraceListProps {
  traces: TraceSummary[];
  loading: boolean;
  error: string | null;
  selectedTraceKey: string | null;
  onSelect: (trace: TraceSummary) => void;
}

const traceKey = (t: { providerId: string; id: string }) =>
  `${t.providerId}:${t.id}`;

/** A trace's running duration, or `undefined` while it's still in flight. */
function traceDuration(t: TraceSummary): number | undefined {
  return t.endTime !== undefined ? t.endTime - t.startTime : undefined;
}

/** Columns the wide (table) layout can sort by — the sidebar-only trio, not name. */
type SortKey = "startTime" | "spanCount" | "duration";

interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

function sortValue(t: TraceSummary, key: SortKey): number | undefined {
  switch (key) {
    case "startTime":
      return t.startTime;
    case "spanCount":
      return t.spanCount;
    case "duration":
      return traceDuration(t);
  }
}

/** A trace still running (`undefined` duration) always sorts last, regardless of direction. */
function sortTraces(traces: TraceSummary[], sort: SortState): TraceSummary[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...traces].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
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
}: {
  label: string;
  icon: React.ReactNode;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className="trace-table-th"
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
        {icon}
        <span className="trace-table-sort-arrow" aria-hidden>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

function TraceList({
  traces,
  loading,
  error,
  selectedTraceKey,
  onSelect,
}: TraceListProps) {
  const [sort, setSort] = useState<SortState>({
    key: "startTime",
    dir: "desc",
  });

  const toggleSort = (key: SortKey) => {
    setSort(prev =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  };

  if (loading) {
    return (
      <>
        <div className="section-panel-header">Traces</div>
        <div className="section-panel-body">
          <div className="tree-status">Loading...</div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="section-panel-header">Traces</div>
        <div className="section-panel-body">
          <div className="tree-status tree-error">Error: {error}</div>
        </div>
      </>
    );
  }

  if (traces.length === 0) {
    return (
      <>
        <div className="section-panel-header">Traces</div>
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

  return (
    <>
      <div className="section-panel-header">Traces</div>
      <div className="section-panel-body trace-list">
        {/* Card layout — the default, and the only one left once the sidebar
            gets too narrow for the table's columns (its meta row disappears
            below that). */}
        <div className="trace-list-cards">
          {sorted.map(trace => {
            const key = traceKey(trace);
            const isSelected = key === selectedTraceKey;
            const duration = traceDuration(trace);
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
                  <span className="trace-list-meta-item">
                    <CalendarIcon />
                    {formatTimestampCompact(trace.startTime)}
                  </span>
                  <span className="trace-list-meta-item">
                    <SpansIcon />
                    {trace.spanCount} span{trace.spanCount === 1 ? "" : "s"}
                  </span>
                  <span className="trace-list-meta-item">
                    <StopwatchIcon />
                    {duration !== undefined
                      ? formatDuration(duration)
                      : "running…"}
                  </span>
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
              <th className="trace-table-name-th">Name</th>
              <SortableHeader
                label="Date"
                icon={<CalendarIcon />}
                sortKey="startTime"
                sort={sort}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Spans"
                icon={<SpansIcon />}
                sortKey="spanCount"
                sort={sort}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Duration"
                icon={<StopwatchIcon />}
                sortKey="duration"
                sort={sort}
                onSort={toggleSort}
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map(trace => {
              const key = traceKey(trace);
              const isSelected = key === selectedTraceKey;
              const duration = traceDuration(trace);
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
                  <td>{formatTimestampCompact(trace.startTime)}</td>
                  <td>{trace.spanCount}</td>
                  <td>
                    {duration !== undefined
                      ? formatDuration(duration)
                      : "running…"}
                  </td>
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
