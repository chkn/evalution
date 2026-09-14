// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Pure span-tree/timeline layout, kept out of `FlameTimeline.tsx` so it can be
 * unit-tested without a browser (see `CLAUDE.md`). `ChatFlow` renders the same
 * {@link Row} list linearly.
 */

import type { Span, SpanKind, SpanMessage } from "../../../shared/types";

export interface Row {
  span: Span;
  depth: number;
}

/** All spans sharing a name, for the "Combined" tree view. */
export interface GroupedRow {
  name: string;
  /** The `kind` of the group's spans (they're assumed homogeneous per name). */
  kind: SpanKind;
  spans: Span[];
}

/**
 * Builds parent-sorted, depth-annotated rows from a flat span list. A span
 * whose `parentId` names something not in `spans` — an OTLP batch delivered
 * without its root, a sampled-away parent — is rendered as a root of its own
 * rather than dropped, so no span is ever silently missing from the
 * waterfall.
 */
export function buildRows(spans: Span[]): Row[] {
  const ids = new Set(spans.map(s => s.id));
  const byParent = new Map<string | undefined, Span[]>();
  for (const span of spans) {
    const parentId =
      span.parentId !== undefined && ids.has(span.parentId)
        ? span.parentId
        : undefined;
    const list = byParent.get(parentId) ?? [];
    list.push(span);
    byParent.set(parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.startTime - b.startTime);
  }

  const rows: Row[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | undefined, depth: number) => {
    for (const span of byParent.get(parentId) ?? []) {
      // A malformed parent cycle would otherwise recurse forever.
      if (seen.has(span.id)) continue;
      seen.add(span.id);
      rows.push({ span, depth });
      visit(span.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return rows;
}

/**
 * Groups a flat span list by `name`, for the "Combined" tree view: each
 * group renders as a single row whose bar shows every instance's extent, so
 * e.g. a tool called in a loop collapses to one row instead of one per call.
 * Groups are ordered by their earliest span's start time, and each group's
 * spans by start time too — both fall out of visiting spans in start order,
 * since a `Map` keeps insertion order.
 */
export function buildGroupedRows(spans: Span[]): GroupedRow[] {
  const groups = new Map<string, GroupedRow>();
  for (const span of [...spans].sort((a, b) => a.startTime - b.startTime)) {
    let group = groups.get(span.name);
    if (!group) {
      group = { name: span.name, kind: span.kind, spans: [] };
      groups.set(span.name, group);
    }
    group.spans.push(span);
  }
  return [...groups.values()];
}

/**
 * Where a span's bar sits on a timeline covering `window`, as CSS percentages
 * ready to pass as `style`. A still-running span extends to the window's end;
 * every bar is at least 0.5% wide so an instantaneous span stays visible (and
 * clickable).
 */
export function barGeometry(
  span: Span,
  window: { start: number; end: number },
): { left: string; width: string } {
  const total = Math.max(1, window.end - window.start);
  const start = span.startTime - window.start;
  const end = (span.endTime ?? window.end) - window.start;
  return {
    left: `${(start / total) * 100}%`,
    width: `${Math.max(0.5, ((end - start) / total) * 100)}%`,
  };
}

/**
 * For `ChatFlow`'s linear thread: maps each `LLM` row's span id to the
 * suffix of its `messages` not already shown by an earlier turn. An `LLM`
 * span's `messages` is the *full* conversation sent to the model, so a later
 * turn's `messages` re-includes everything already rendered by earlier
 * turns — not just their `messages`, but also their `output`, which the next
 * turn's `messages` folds back in as an assistant message once the
 * conversation continues. This trims that repeated prefix, counting a prior
 * turn's `output` (if any) as one extra already-shown message.
 */
export function newMessagesByTurn(rows: Row[]): Map<string, SpanMessage[]> {
  const result = new Map<string, SpanMessage[]>();
  let shownCount = 0;
  for (const row of rows) {
    if (row.span.kind !== "LLM") continue;
    const allMessages = row.span.llm?.messages ?? [];
    result.set(row.span.id, allMessages.slice(shownCount));
    shownCount = Math.max(
      shownCount,
      allMessages.length + (row.span.llm?.output ? 1 : 0),
    );
  }
  return result;
}

/**
 * A span's elapsed time in ms, or `undefined` while it is still running
 * (no `endTime` yet) — the one derived quantity the timeline and chat views
 * both need from a raw `Span`.
 */
export function spanDuration(span: Span): number | undefined {
  return span.endTime !== undefined ? span.endTime - span.startTime : undefined;
}

/** The time window the timeline should cover, in ms. */
export function computeWindow(
  traceStart: number,
  traceEnd: number | undefined,
  spans: Span[],
): { start: number; end: number } {
  let start = traceStart;
  let end = traceEnd ?? traceStart;
  for (const span of spans) {
    if (span.startTime < start) start = span.startTime;
    const spanEnd = span.endTime ?? span.startTime;
    if (spanEnd > end) end = spanEnd;
  }
  if (end <= start) end = start + 1;
  return { start, end };
}
