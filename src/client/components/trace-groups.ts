// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { PLAYGROUND_ENVIRONMENT, summarizeTraces } from "@evalution/sdk";
import type {
  TraceGroup,
  TraceGroupBy,
  TraceSummary,
  VariationInfo,
} from "../../shared/types";
import { traceGroupLabel } from "./trace-list-view";

/**
 * One trace-list entry: a trace, or a group of traces gathered under one row
 * — an eval run's, a stretch of playground runs, or those sharing a column's
 * value — summarizing them all. The traces themselves are its `children`,
 * which a column's `group` has only once they've been fetched.
 */
export type TraceListItem = TraceSummary & {
  children?: TraceSummary[];
  /** Set for a group by a column: what the server said of it. */
  group?: TraceGroup;
};

/**
 * A group row standing for `traces` (non-empty): what they add up to, with
 * the traces themselves under it.
 */
function summaryGroup(
  traces: TraceSummary[],
  row: Pick<TraceSummary, "providerId" | "id" | "name" | "evalRun">,
): TraceListItem {
  return { ...row, ...summarizeTraces(traces), children: traces };
}

/** The group row for one eval run's traces, named for the eval. */
function evalRunGroup(traces: TraceSummary[]): TraceListItem {
  const evalRun = traces[0]!.evalRun!;
  return summaryGroup(traces, {
    providerId: evalRun.providerId,
    id: `eval-run:${evalRun.runId}`,
    name: evalRun.evalName,
    evalRun,
  });
}

/**
 * The group row for a stretch of playground runs. Its id is the oldest run's,
 * so it stays the same row (expanded or not) as new runs join it.
 */
function playgroundGroup(traces: TraceSummary[]): TraceListItem {
  const oldest = traces.reduce((a, b) => (b.startTime < a.startTime ? b : a));
  return summaryGroup(traces, {
    providerId: oldest.providerId,
    id: `playground:${oldest.id}`,
    name: "Playground",
  });
}

/** Whether `item` is a lone run made in the playground — not part of an eval. */
function isPlaygroundRun(item: TraceListItem): boolean {
  return (
    !item.children &&
    !item.evalRun &&
    item.environment === PLAYGROUND_ENVIRONMENT
  );
}

/**
 * `traces` (in list order, newest first) as the trace list shows them:
 * every eval run's traces gathered under one group row, in place of the
 * first of them, then every stretch of two or more playground runs with
 * nothing else between them gathered under another. Anything else is left as
 * it is.
 */
export function groupTraces(traces: TraceSummary[]): TraceListItem[] {
  const runs = new Map<string, TraceSummary[]>();
  for (const trace of traces) {
    if (!trace.evalRun) continue;
    const key = `${trace.evalRun.providerId}:${trace.evalRun.runId}`;
    const members = runs.get(key);
    if (members) members.push(trace);
    else runs.set(key, [trace]);
  }

  const items: TraceListItem[] = [];
  for (const trace of traces) {
    if (!trace.evalRun) {
      items.push(trace);
      continue;
    }
    const key = `${trace.evalRun.providerId}:${trace.evalRun.runId}`;
    const members = runs.get(key);
    if (members) {
      items.push(evalRunGroup(members));
      runs.delete(key); // Placed — the rest of its traces go under it.
    }
  }

  const grouped: TraceListItem[] = [];
  for (let i = 0; i < items.length; ) {
    let end = i;
    while (end < items.length && isPlaygroundRun(items[end]!)) end++;
    if (end - i >= 2) {
      grouped.push(playgroundGroup(items.slice(i, end)));
      i = end;
    } else {
      grouped.push(items[i]!);
      i++;
    }
  }
  return grouped;
}

/**
 * The groups of a listing grouped by a column, as the trace list shows them:
 * a row per group, named for what its traces share, with those of
 * `members` (by group key) that have been fetched under it.
 */
export function columnGroupItems(
  groups: TraceGroup[],
  members: Record<string, TraceSummary[] | undefined>,
  groupBy: TraceGroupBy,
  variations: Record<string, VariationInfo> = {},
): TraceListItem[] {
  return groups.map(group => {
    const children = members[group.key];
    return {
      providerId: "",
      id: `group:${group.key}`,
      name: traceGroupLabel(group.filter, groupBy, variations),
      ...group.summary,
      group,
      ...(children && { children }),
    };
  });
}
