// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

/**
 * Searching, filtering and grouping a trace listing: the query a trace
 * provider is asked to answer, and a reference implementation of it over
 * summaries held in memory, which a provider that can't push the query down
 * to its store uses as is.
 */

import type { EvalCounts, TraceSummary } from "./trace-types.ts";

/** The trace-list columns whose value is text, or unset. */
export type TraceTextColumn =
  | "name"
  | "status"
  | "model"
  | "environment"
  | "annotations"
  | "checks"
  | "version"
  | "variation";

/** The trace-list columns whose value is a number, or unset. */
export type TraceNumberColumn =
  | "startTime"
  | "spanCount"
  | "duration"
  | "totalTokens"
  | "cost";

/** A trace-list column a listing can be filtered or grouped by. */
export type TraceQueryColumn = TraceTextColumn | TraceNumberColumn;

const TEXT_COLUMNS: readonly TraceTextColumn[] = [
  "name",
  "status",
  "model",
  "environment",
  "annotations",
  "checks",
  "version",
  "variation",
];

const NUMBER_COLUMNS: readonly TraceNumberColumn[] = [
  "startTime",
  "spanCount",
  "duration",
  "totalTokens",
  "cost",
];

/** Whether `column` names a {@link TraceTextColumn}. */
export function isTraceTextColumn(column: unknown): column is TraceTextColumn {
  return TEXT_COLUMNS.includes(column as TraceTextColumn);
}

/** Whether `column` names a {@link TraceNumberColumn}. */
export function isTraceNumberColumn(
  column: unknown,
): column is TraceNumberColumn {
  return NUMBER_COLUMNS.includes(column as TraceNumberColumn);
}

/**
 * One condition on a trace's column. A trace is listed only if it meets every
 * filter of the query.
 *
 * - `in` / `notIn`: the column's value is, or isn't, one of `values`, where
 *   `null` stands for a trace with no value.
 * - `range`: the column's value is in `[min, max)`. A trace with no value
 *   never is.
 * - `unset`: the trace has no value: no cost reported, say, or no duration
 *   because it's still running.
 */
export type TraceFilter =
  | {
      column: TraceTextColumn;
      op: "in" | "notIn";
      values: (string | null)[];
    }
  | { column: TraceNumberColumn; op: "range"; min?: number; max?: number }
  | { column: TraceNumberColumn; op: "unset" };

/** Which traces a listing holds. */
export interface TraceQuery {
  /**
   * Only traces whose name or id contains this text, whatever its case.
   * Blank matches everything.
   */
  search?: string;
  /** Only traces that meet every one of these. */
  filters?: TraceFilter[];
}

/** How finely grouping by a trace's start time divides it. */
export type TraceDateResolution = "hour" | "day" | "week" | "month";

const DATE_RESOLUTIONS: readonly TraceDateResolution[] = [
  "hour",
  "day",
  "week",
  "month",
];

/**
 * The column a listing is grouped by. Text columns group traces with the
 * same value; `startTime` groups by the hour, day, week (from Monday) or
 * month a trace started in; the other number columns group into the buckets
 * of {@link TRACE_BUCKET_BOUNDS}, with the traces that have no value in a
 * group of their own.
 */
export interface TraceGroupBy {
  column: TraceQueryColumn;
  /** For `startTime`. Defaults to `"day"`. */
  resolution?: TraceDateResolution;
}

/** A {@link TraceQuery} whose matches are returned as groups. */
export interface TraceGroupQuery extends TraceQuery {
  groupBy: TraceGroupBy;
  /**
   * The IANA time zone days, weeks and months begin in, e.g.
   * `"Europe/Berlin"`. Defaults to UTC.
   */
  timeZone?: string;
}

/**
 * What a group of traces adds up to: spanning from the first trace's start to
 * the last one's end, with counts summed, and anything the traces don't all
 * agree on left unset.
 */
export type TraceGroupSummary = Omit<
  TraceSummary,
  "id" | "providerId" | "name" | "evalRun"
>;

/** The traces of a listing that share a value, or a bucket, of a column. */
export interface TraceGroup {
  /** Names the group among those of one listing, the same from any provider. */
  key: string;
  /**
   * What the group's traces have in common. Added to the query's filters, it
   * lists exactly them.
   */
  filter: TraceFilter;
  /** How many traces the group holds. */
  count: number;
  summary: TraceGroupSummary;
}

/**
 * The lower bounds of every bucket but the first, for the number columns
 * grouped into buckets: `[1000, 5000]` makes the buckets `< 1000`,
 * `1000 – 5000` and `≥ 5000`. Durations are in ms and costs in dollars.
 */
export const TRACE_BUCKET_BOUNDS: Record<
  Exclude<TraceNumberColumn, "startTime">,
  readonly number[]
> = {
  spanCount: [2, 6, 21, 101],
  duration: [1_000, 5_000, 15_000, 60_000, 300_000],
  totalTokens: [1_000, 10_000, 100_000, 1_000_000],
  cost: [0.001, 0.01, 0.1, 1, 10],
};

/** A trace's value in a text column, or `null` if it has none. */
export function traceTextValue(
  trace: TraceGroupMember,
  column: TraceTextColumn,
): string | null {
  switch (column) {
    case "name":
      return trace.name;
    case "status":
      return trace.status;
    case "model":
      return trace.model ?? null;
    case "environment":
      return trace.environment ?? null;
    case "version":
      return trace.promptVersion ?? null;
    case "variation":
      return trace.promptVariation ?? null;
    case "annotations": {
      // The most pressing kind the trace has any of.
      const counts = trace.annotationCounts;
      return counts.issue > 0
        ? "issue"
        : counts.good > 0
          ? "good"
          : counts.note > 0
            ? "note"
            : null;
    }
    case "checks": {
      // Likewise: one failed check outweighs any number that passed.
      const counts = trace.checkCounts;
      if (!counts) return null;
      const order: (keyof EvalCounts)[] = [
        "fail",
        "error",
        "pass",
        "scored",
        "skipped",
      ];
      return order.find(outcome => counts[outcome] > 0) ?? null;
    }
  }
}

/** A trace's value in a number column, or `undefined` if it has none. */
export function traceNumberValue(
  trace: TraceGroupMember,
  column: TraceNumberColumn,
): number | undefined {
  switch (column) {
    case "startTime":
      return trace.startTime;
    case "spanCount":
      return trace.spanCount;
    case "duration":
      return trace.endTime !== undefined
        ? trace.endTime - trace.startTime
        : undefined;
    case "totalTokens":
      return trace.totalTokens;
    case "cost":
      return trace.cost;
  }
}

/** What of a trace filtering and grouping read. */
type TraceGroupMember = Pick<TraceSummary, "name"> & TraceGroupSummary;

/** Whether `trace` meets `filter`. */
export function matchesTraceFilter(
  trace: TraceSummary,
  filter: TraceFilter,
): boolean {
  switch (filter.op) {
    case "in":
      return filter.values.includes(traceTextValue(trace, filter.column));
    case "notIn":
      return !filter.values.includes(traceTextValue(trace, filter.column));
    case "unset":
      return traceNumberValue(trace, filter.column) === undefined;
    case "range": {
      const value = traceNumberValue(trace, filter.column);
      return (
        value !== undefined &&
        (filter.min === undefined || value >= filter.min) &&
        (filter.max === undefined || value < filter.max)
      );
    }
  }
}

/** Whether `trace` is one `query` lists. */
export function matchesTraceQuery(
  trace: TraceSummary,
  query: TraceQuery,
): boolean {
  const search = query.search?.trim().toLowerCase();
  if (
    search &&
    !trace.name.toLowerCase().includes(search) &&
    !trace.id.toLowerCase().includes(search)
  ) {
    return false;
  }
  return (query.filters ?? []).every(filter =>
    matchesTraceFilter(trace, filter),
  );
}

/** Whether `query` lists every trace. */
export function isEmptyTraceQuery(query: TraceQuery | undefined): boolean {
  return !query?.search?.trim() && !query?.filters?.length;
}

/** The traces of `traces` that `query` lists, in the same order. */
export function filterTraces<T extends TraceSummary>(
  traces: T[],
  query: TraceQuery | undefined,
): T[] {
  if (!query || isEmptyTraceQuery(query)) return traces;
  return traces.filter(trace => matchesTraceQuery(trace, query));
}

// ─── Buckets ────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

/** Each time zone's wall-clock formatter: slow to make, so made once. */
const wallClocks = new Map<string, Intl.DateTimeFormat>();

function wallClock(timeZone: string): Intl.DateTimeFormat {
  let format = wallClocks.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallClocks.set(timeZone, format);
  }
  return format;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `ms`, in ms. */
function zoneOffset(ms: number, timeZone: string): number {
  if (timeZone === "UTC") return 0;
  const parts = Object.fromEntries(
    wallClock(timeZone)
      .formatToParts(ms)
      .map(part => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant `timeZone`'s wall clock reads `wall` (a time written as if UTC). */
function fromWallTime(wall: number, timeZone: string): number {
  // The offset where the guess lands, then where that lands: settles
  // everywhere but inside a clock change, where either answer will do.
  const guess = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(guess, timeZone);
}

/**
 * The `[min, max)` of the hour, day, week or month `ms` falls in, on
 * `timeZone`'s clock.
 */
export function traceDateBucket(
  ms: number,
  resolution: TraceDateResolution = "day",
  timeZone = "UTC",
): { min: number; max: number } {
  const offset = zoneOffset(ms, timeZone);
  if (resolution === "hour") {
    // Counted in elapsed time, so the hour a clock change repeats stays two.
    const min = Math.floor((ms + offset) / HOUR_MS) * HOUR_MS - offset;
    return { min, max: min + HOUR_MS };
  }
  const wall = new Date(ms + offset);
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth();
  const day = wall.getUTCDate();
  let from: number;
  let to: number;
  if (resolution === "month") {
    from = Date.UTC(year, month, 1);
    to = Date.UTC(year, month + 1, 1);
  } else if (resolution === "week") {
    const sinceMonday = (wall.getUTCDay() + 6) % 7;
    from = Date.UTC(year, month, day - sinceMonday);
    to = Date.UTC(year, month, day - sinceMonday + 7);
  } else {
    from = Date.UTC(year, month, day);
    to = Date.UTC(year, month, day + 1);
  }
  return {
    min: fromWallTime(from, timeZone),
    max: fromWallTime(to, timeZone),
  };
}

/**
 * The bucket of `column` that `value` falls in, as the filter listing it:
 * see {@link TRACE_BUCKET_BOUNDS}.
 */
export function traceBucketFilter(
  column: Exclude<TraceNumberColumn, "startTime">,
  value: number | undefined,
): TraceFilter {
  if (value === undefined) return { column, op: "unset" };
  const bounds = TRACE_BUCKET_BOUNDS[column];
  return traceBucketAt(column, bounds.filter(bound => value >= bound).length);
}

/**
 * The `index`th bucket of `column`, counting from the one below every bound
 * of {@link TRACE_BUCKET_BOUNDS}, as the filter listing it.
 */
export function traceBucketAt(
  column: Exclude<TraceNumberColumn, "startTime">,
  index: number,
): TraceFilter {
  const bounds = TRACE_BUCKET_BOUNDS[column];
  const min = index > 0 ? bounds[index - 1] : undefined;
  const max = index < bounds.length ? bounds[index] : undefined;
  return {
    column,
    op: "range",
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
  };
}

/** The filter listing the group of `groupBy` that `trace` belongs to. */
export function traceGroupFilter(
  trace: TraceSummary,
  groupBy: TraceGroupBy,
  timeZone?: string,
): TraceFilter {
  const { column } = groupBy;
  if (isTraceTextColumn(column)) {
    return { column, op: "in", values: [traceTextValue(trace, column)] };
  }
  if (column === "startTime") {
    return {
      column,
      op: "range",
      ...traceDateBucket(trace.startTime, groupBy.resolution, timeZone),
    };
  }
  return traceBucketFilter(column, traceNumberValue(trace, column));
}

/** {@link TraceGroup.key} for the group `filter` lists. */
export function traceGroupKey(filter: TraceFilter): string {
  switch (filter.op) {
    case "in":
    case "notIn":
      return `${filter.column}:${filter.op}:${JSON.stringify(filter.values)}`;
    case "unset":
      return `${filter.column}:unset`;
    case "range":
      return `${filter.column}:range:${filter.min ?? ""}:${filter.max ?? ""}`;
  }
}

// ─── Grouping ───────────────────────────────────────────────────────────────

/** The one value every item agrees on, else `undefined`. */
function shared<V>(values: (V | undefined)[]): V | undefined {
  const first = values[0];
  return values.every(v => v === first) ? first : undefined;
}

/** The sum of the values that are set; `undefined` when none is. */
function sum(values: (number | undefined)[]): number | undefined {
  const set = values.filter((v): v is number => v !== undefined);
  return set.length > 0 ? set.reduce((a, b) => a + b, 0) : undefined;
}

/** `counts` added up; `undefined` when none is set. */
function sumCounts(counts: (EvalCounts | undefined)[]): EvalCounts | undefined {
  const set = counts.filter(c => c !== undefined);
  if (set.length === 0) return undefined;
  const total: EvalCounts = {
    pass: 0,
    fail: 0,
    error: 0,
    skipped: 0,
    scored: 0,
  };
  for (const c of set) {
    for (const outcome of Object.keys(total) as (keyof EvalCounts)[]) {
      total[outcome] += c[outcome];
    }
  }
  return total;
}

/**
 * What `traces` (non-empty) add up to. Takes summaries of groups as well as
 * traces, so the groups of several listings can be added together.
 */
export function summarizeTraces(
  traces: readonly TraceGroupSummary[],
): TraceGroupSummary {
  const running = traces.some(t => t.status === "running");
  const totalTokens = sum(traces.map(t => t.totalTokens));
  const cost = sum(traces.map(t => t.cost));
  const checkCounts = sumCounts(traces.map(t => t.checkCounts));
  const model = shared(traces.map(t => t.model));
  const environment = shared(traces.map(t => t.environment));
  const promptVersion = shared(traces.map(t => t.promptVersion));
  const promptVariation = shared(traces.map(t => t.promptVariation));
  return {
    startTime: Math.min(...traces.map(t => t.startTime)),
    ...(!running && {
      endTime: Math.max(...traces.map(t => t.endTime ?? t.startTime)),
    }),
    status: running
      ? "running"
      : traces.some(t => t.status === "error")
        ? "error"
        : "ok",
    spanCount: traces.reduce((n, t) => n + t.spanCount, 0),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(cost !== undefined && { cost }),
    ...(checkCounts && { checkCounts }),
    ...(model !== undefined && { model }),
    ...(environment !== undefined && { environment }),
    ...(promptVersion !== undefined && { promptVersion }),
    ...(promptVariation !== undefined && { promptVariation }),
    annotationCounts: {
      issue: traces.reduce((n, t) => n + t.annotationCounts.issue, 0),
      good: traces.reduce((n, t) => n + t.annotationCounts.good, 0),
      note: traces.reduce((n, t) => n + t.annotationCounts.note, 0),
    },
  };
}

/**
 * `traces` as the groups of `groupBy`, in the order their first traces come.
 * Filter them first: this groups every trace it's given.
 */
export function groupTraceSummaries(
  traces: TraceSummary[],
  groupBy: TraceGroupBy,
  timeZone?: string,
): TraceGroup[] {
  const members = new Map<
    string,
    { filter: TraceFilter; traces: TraceSummary[] }
  >();
  for (const trace of traces) {
    const filter = traceGroupFilter(trace, groupBy, timeZone);
    const key = traceGroupKey(filter);
    const group = members.get(key);
    if (group) group.traces.push(trace);
    else members.set(key, { filter, traces: [trace] });
  }
  return Array.from(members, ([key, group]) => ({
    key,
    filter: group.filter,
    count: group.traces.length,
    summary: summarizeTraces(group.traces),
  }));
}

/**
 * The groups of several listings as one: those with the same key added
 * together, in the order their keys first come.
 */
export function mergeTraceGroups(groups: TraceGroup[]): TraceGroup[] {
  const byKey = new Map<string, TraceGroup[]>();
  for (const group of groups) {
    const same = byKey.get(group.key);
    if (same) same.push(group);
    else byKey.set(group.key, [group]);
  }
  return Array.from(byKey.values(), same =>
    same.length === 1
      ? same[0]
      : {
          key: same[0].key,
          filter: same[0].filter,
          count: same.reduce((n, group) => n + group.count, 0),
          summary: summarizeTraces(same.map(group => group.summary)),
        },
  );
}

// ─── On the wire ────────────────────────────────────────────────────────────

const optionalNumber = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));

/** `value` as a {@link TraceFilter}. Throws a `TypeError` if it isn't one. */
function parseTraceFilter(value: unknown): TraceFilter {
  const filter = value as Record<string, unknown> | null;
  if (filter && typeof filter === "object") {
    const { column, op } = filter;
    if (op === "in" || op === "notIn") {
      const { values } = filter;
      if (
        isTraceTextColumn(column) &&
        Array.isArray(values) &&
        values.every(v => v === null || typeof v === "string")
      ) {
        return { column, op, values };
      }
    } else if (op === "unset") {
      if (isTraceNumberColumn(column)) return { column, op };
    } else if (op === "range") {
      const { min, max } = filter;
      if (
        isTraceNumberColumn(column) &&
        optionalNumber(min) &&
        optionalNumber(max)
      ) {
        return {
          column,
          op,
          ...(min !== undefined && { min }),
          ...(max !== undefined && { max }),
        };
      }
    }
  }
  throw new TypeError(`Not a trace filter: ${JSON.stringify(value)}`);
}

/** The query parameters a {@link TraceQuery} or {@link TraceGroupQuery} travels as. */
export function traceQueryParams(
  query: TraceQuery & Partial<TraceGroupQuery>,
): Record<string, string> {
  const search = query.search?.trim();
  return {
    ...(search && { q: search }),
    ...(query.filters?.length && { filters: JSON.stringify(query.filters) }),
    ...(query.groupBy && {
      groupBy: query.groupBy.column,
      ...(query.groupBy.resolution && {
        resolution: query.groupBy.resolution,
      }),
    }),
    ...(query.timeZone && { tz: query.timeZone }),
  };
}

/**
 * The {@link TraceQuery} that {@link traceQueryParams} wrote into `params`.
 * Throws a `TypeError` naming what's wrong with one that can't be read.
 */
export function parseTraceQuery(
  params: Record<string, string | undefined>,
): TraceQuery {
  const search = params.q?.trim();
  let filters: TraceFilter[] | undefined;
  if (params.filters) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params.filters);
    } catch {
      throw new TypeError("`filters` isn't JSON.");
    }
    if (!Array.isArray(parsed)) {
      throw new TypeError("`filters` isn't an array.");
    }
    filters = parsed.map(parseTraceFilter);
  }
  return {
    ...(search && { search }),
    ...(filters?.length && { filters }),
  };
}

/** {@link parseTraceQuery} for the parameters of a {@link TraceGroupQuery}. */
export function parseTraceGroupQuery(
  params: Record<string, string | undefined>,
): TraceGroupQuery {
  const { groupBy: column, resolution, tz } = params;
  if (!isTraceTextColumn(column) && !isTraceNumberColumn(column)) {
    throw new TypeError("`groupBy` isn't a trace column.");
  }
  if (
    resolution !== undefined &&
    !DATE_RESOLUTIONS.includes(resolution as TraceDateResolution)
  ) {
    throw new TypeError("`resolution` isn't hour, day, week or month.");
  }
  if (tz !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      throw new TypeError("`tz` isn't a time zone.");
    }
  }
  return {
    ...parseTraceQuery(params),
    groupBy: {
      column,
      ...(resolution && { resolution: resolution as TraceDateResolution }),
    },
    ...(tz && { timeZone: tz }),
  };
}
