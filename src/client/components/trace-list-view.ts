// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  isTraceNumberColumn,
  isTraceTextColumn,
  type TraceTextColumn,
} from "@evalution/sdk";
import { shortId } from "../../shared/helpers";
import type {
  TraceDateResolution,
  TraceFilter,
  TraceGroupBy,
  TraceNumberColumn,
  TraceQueryColumn,
  VariationInfo,
} from "../../shared/types";
import { variationLabel } from "./prompt-ref";
import { formatTimestampCompact } from "./trace/format.ts";

/**
 * How the trace list gathers its traces: `"runs"` under their eval run or
 * stretch of playground runs, `"none"` not at all, or by a column.
 */
export type TraceListGrouping = "runs" | "none" | TraceGroupBy;

/** Which traces the trace list shows, and how it groups them. */
export interface TraceListView {
  search: string;
  /** At most one per column, which is all the list's filter editor makes. */
  filters: TraceFilter[];
  grouping: TraceListGrouping;
}

/** The view a fresh install starts with: every trace, under its run. */
export const DEFAULT_TRACE_LIST_VIEW: TraceListView = {
  search: "",
  filters: [],
  grouping: "runs",
};

const RESOLUTIONS: TraceDateResolution[] = ["hour", "day", "week", "month"];

/**
 * Recover a grouping from parsed JSON (localStorage): anything that isn't
 * one falls back to `"runs"`.
 */
export function parseTraceGrouping(raw: unknown): TraceListGrouping {
  if (raw === "runs" || raw === "none") return raw;
  const { column, resolution } = (raw ?? {}) as Partial<TraceGroupBy>;
  if (!isTraceTextColumn(column) && !isTraceNumberColumn(column)) return "runs";
  return column === "startTime"
    ? { column, resolution: RESOLUTIONS.find(r => r === resolution) ?? "day" }
    : { column };
}

/** Every column the list filters and groups by, in the order they're offered. */
export const TRACE_QUERY_COLUMNS: TraceQueryColumn[] = [
  "name",
  "status",
  "startTime",
  "spanCount",
  "duration",
  "totalTokens",
  "model",
  "environment",
  "cost",
  "annotations",
  "checks",
  "version",
  "variation",
];

/** What each column is called. */
export const TRACE_COLUMN_LABELS: Record<TraceQueryColumn, string> = {
  name: "Name",
  status: "Status",
  startTime: "Date",
  spanCount: "Spans",
  duration: "Duration",
  totalTokens: "Tokens",
  model: "Model",
  environment: "Environment",
  cost: "Cost",
  annotations: "Annotations",
  checks: "Checks",
  version: "Version",
  variation: "Variation",
};

/** What each date resolution is called. */
export const TRACE_RESOLUTION_LABELS: Record<TraceDateResolution, string> = {
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
};

/** The values of the columns that only take these, by what they're called. */
const VALUE_LABELS: Partial<Record<TraceTextColumn, Record<string, string>>> = {
  status: { ok: "OK", error: "Error", running: "Running" },
  annotations: { issue: "Issues", good: "Good", note: "Notes" },
  checks: {
    fail: "Failing",
    error: "Errored",
    pass: "Passing",
    scored: "Scored",
    skipped: "Skipped",
  },
};

/** What a trace with no value in a column is said to have. */
const NO_VALUE_LABELS: Record<TraceQueryColumn, string> = {
  name: "No name",
  status: "No status",
  startTime: "No date",
  spanCount: "No spans",
  duration: "Running",
  totalTokens: "No tokens",
  model: "No model",
  environment: "No environment",
  cost: "No cost",
  annotations: "No annotations",
  checks: "No checks",
  version: "No version",
  variation: "No variation",
};

/** How a text column's `value` reads; `null` is a trace with none. */
export function traceValueLabel(
  column: TraceTextColumn,
  value: string | null,
  variations: Record<string, VariationInfo> = {},
): string {
  if (value === null) return NO_VALUE_LABELS[column];
  if (column === "version") return shortId(value);
  if (column === "variation") {
    const info = variations[value];
    return info?.names.length ? variationLabel(info) : shortId(value);
  }
  return VALUE_LABELS[column]?.[value] ?? value;
}

/** A duration as a bucket's bound: whole units, no decimals to line up. */
function formatDurationBound(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${ms / 1000}s`;
  return `${ms / 60_000}m`;
}

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** How a number column's bound reads. */
function formatBound(column: TraceNumberColumn, value: number): string {
  switch (column) {
    case "startTime":
      return formatTimestampCompact(value);
    case "duration":
      return formatDurationBound(value);
    case "cost":
      return `$${Number(value.toPrecision(3))}`;
    case "totalTokens":
      return compactNumber.format(value);
    case "spanCount":
      return String(value);
  }
}

/** How a `[min, max)` of a number column reads. */
function rangeLabel(
  column: TraceNumberColumn,
  min: number | undefined,
  max: number | undefined,
): string {
  if (column === "spanCount") {
    // Whole numbers, so the range is named by the last count in it.
    const from = min ?? 0;
    if (max === undefined) return min === undefined ? "Any" : `${from}+`;
    return max - 1 <= from ? String(from) : `${from}–${max - 1}`;
  }
  if (min === undefined) {
    return max === undefined ? "Any" : `< ${formatBound(column, max)}`;
  }
  if (max === undefined) return `≥ ${formatBound(column, min)}`;
  return `${formatBound(column, min)} – ${formatBound(column, max)}`;
}

/** How the hour, day, week or month starting at `ms` reads. */
function dateBucketLabel(ms: number, resolution: TraceDateResolution): string {
  const date = new Date(ms);
  switch (resolution) {
    case "hour":
      return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
      });
    case "day":
      return date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    case "week":
      return `Week of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    case "month":
      return date.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
  }
}

/** What `filter` allows, without the column's name: `gpt-5, No model`, `< 1s`. */
export function traceFilterValueLabel(
  filter: TraceFilter,
  variations: Record<string, VariationInfo> = {},
): string {
  switch (filter.op) {
    case "in":
    case "notIn": {
      const values = filter.values
        .map(value => traceValueLabel(filter.column, value, variations))
        .join(", ");
      return filter.op === "in" ? values : `not ${values}`;
    }
    case "unset":
      return NO_VALUE_LABELS[filter.column];
    case "range":
      return rangeLabel(filter.column, filter.min, filter.max);
  }
}

/** How a filter reads in the list of those applied: `Model: gpt-5`. */
export function traceFilterLabel(
  filter: TraceFilter,
  variations: Record<string, VariationInfo> = {},
): string {
  return `${TRACE_COLUMN_LABELS[filter.column]}: ${traceFilterValueLabel(filter, variations)}`;
}

/** What the row of the group that `filter` lists is called. */
export function traceGroupLabel(
  filter: TraceFilter,
  groupBy: TraceGroupBy,
  variations: Record<string, VariationInfo> = {},
): string {
  if (filter.op === "range") {
    if (filter.column === "startTime" && filter.min !== undefined) {
      return dateBucketLabel(filter.min, groupBy.resolution ?? "day");
    }
    if (filter.column === "spanCount") {
      const range = rangeLabel("spanCount", filter.min, filter.max);
      return `${range} ${range === "1" ? "span" : "spans"}`;
    }
  }
  return traceFilterValueLabel(filter, variations);
}

/**
 * `filters` with `column`'s replaced by `filter`, or dropped when there's
 * none: the list keeps one filter per column.
 */
export function setColumnFilter(
  filters: TraceFilter[],
  column: TraceQueryColumn,
  filter: TraceFilter | undefined,
): TraceFilter[] {
  const index = filters.findIndex(f => f.column === column);
  if (!filter) return filters.filter(f => f.column !== column);
  if (index < 0) return [...filters, filter];
  return filters.map((f, i) => (i === index ? filter : f));
}

/**
 * How a number column's filter is typed: in a unit `scale` of the column's
 * own make one of (durations are stored in ms and typed in seconds), and for
 * a column of whole numbers, with a `max` that is itself allowed.
 */
export const TRACE_FILTER_UNITS: Record<
  Exclude<TraceNumberColumn, "startTime">,
  { scale: number; unit: string; whole?: boolean }
> = {
  spanCount: { scale: 1, unit: "spans", whole: true },
  duration: { scale: 1000, unit: "seconds" },
  totalTokens: { scale: 1, unit: "tokens", whole: true },
  cost: { scale: 1, unit: "$" },
};

/**
 * The range filter that the numbers typed for `column` spell, or `undefined`
 * when there are none.
 */
export function typedRangeFilter(
  column: Exclude<TraceNumberColumn, "startTime">,
  min: number | undefined,
  max: number | undefined,
): TraceFilter | undefined {
  const { scale, whole } = TRACE_FILTER_UNITS[column];
  return rangeFilter(
    column,
    min !== undefined ? min * scale : undefined,
    max !== undefined ? (max + (whole ? 1 : 0)) * scale : undefined,
  );
}

/** What was typed to make `filter`: {@link typedRangeFilter}'s inverse. */
export function typedRange(
  column: Exclude<TraceNumberColumn, "startTime">,
  filter: TraceFilter | undefined,
): { min?: number; max?: number } {
  if (filter?.op !== "range") return {};
  const { scale, whole } = TRACE_FILTER_UNITS[column];
  return {
    ...(filter.min !== undefined && { min: filter.min / scale }),
    ...(filter.max !== undefined && {
      max: filter.max / scale - (whole ? 1 : 0),
    }),
  };
}

/** `ms` as a `datetime-local` input's value, on the local clock. */
export function toDateTimeInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` input's value names; `undefined` when blank. */
export function fromDateTimeInput(value: string): number | undefined {
  const ms = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/** The filter for `column` in `[min, max)`, or `undefined` when neither is set. */
export function rangeFilter(
  column: TraceNumberColumn,
  min: number | undefined,
  max: number | undefined,
): TraceFilter | undefined {
  if (min === undefined && max === undefined) return undefined;
  return {
    column,
    op: "range",
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
  };
}
