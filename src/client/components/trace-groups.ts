// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { AnnotationKind, TraceSummary } from "../../shared/types";
import { PLAYGROUND_ENVIRONMENT } from "../../trace/trace-types";

/**
 * One trace-list entry: a trace, or a group of traces gathered under one row
 * — an eval run's, or a stretch of playground runs — summarizing them all,
 * with the traces themselves as `children`.
 */
export type TraceListItem = TraceSummary & { children?: TraceSummary[] };

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

/**
 * A group row standing for `traces` (non-empty): spanning from the first
 * trace's start to the last one's end, with counts summed and anything the
 * traces don't all agree on left unset.
 */
function summaryGroup(
  traces: TraceSummary[],
  row: Pick<TraceSummary, "providerId" | "id" | "name" | "evalRun">,
): TraceListItem {
  const running = traces.some(t => t.status === "running");
  const kinds: AnnotationKind[] = ["issue", "good", "note"];
  const totalTokens = sum(traces.map(t => t.totalTokens));
  const cost = sum(traces.map(t => t.cost));
  const model = shared(traces.map(t => t.model));
  const promptVersion = shared(traces.map(t => t.promptVersion));
  const promptVariation = shared(traces.map(t => t.promptVariation));
  return {
    ...row,
    startTime: Math.min(...traces.map(t => t.startTime)),
    ...(!running && { endTime: Math.max(...traces.map(t => t.endTime!)) }),
    status: running
      ? "running"
      : traces.some(t => t.status === "error")
        ? "error"
        : "ok",
    spanCount: traces.reduce((n, t) => n + t.spanCount, 0),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(cost !== undefined && { cost }),
    ...(model !== undefined && { model }),
    ...(promptVersion !== undefined && { promptVersion }),
    ...(promptVariation !== undefined && { promptVariation }),
    annotationCounts: Object.fromEntries(
      kinds.map(kind => [
        kind,
        traces.reduce((n, t) => n + t.annotationCounts[kind], 0),
      ]),
    ) as Record<AnnotationKind, number>,
    children: traces,
  };
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
