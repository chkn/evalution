// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Pure span-tree/timeline layout, kept out of `FlameTimeline.tsx` so it can be
 * unit-tested without a browser (see `CLAUDE.md`). `ChatFlow` renders the same
 * {@link Row} list linearly.
 */

import type { SpanViewModel } from "./spanViewModel.ts";

export interface Row {
  span: SpanViewModel;
  depth: number;
}

/**
 * Builds parent-sorted, depth-annotated rows from a flat span list. A span
 * whose `parentId` names something not in `spans` — an OTLP batch delivered
 * without its root, a sampled-away parent — is rendered as a root of its own
 * rather than dropped, so no span is ever silently missing from the
 * waterfall.
 */
export function buildRows(spans: SpanViewModel[]): Row[] {
  const ids = new Set(spans.map(s => s.id));
  const byParent = new Map<string | undefined, SpanViewModel[]>();
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
    list.sort((a, b) => a.startMs - b.startMs);
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

/** The time window the timeline should cover, in ms. */
export function computeWindow(
  traceStart: number,
  traceEnd: number | undefined,
  spans: SpanViewModel[],
): { start: number; end: number } {
  let start = traceStart;
  let end = traceEnd ?? traceStart;
  for (const span of spans) {
    if (span.startMs < start) start = span.startMs;
    const spanEnd = span.endMs ?? span.startMs;
    if (spanEnd > end) end = spanEnd;
  }
  if (end <= start) end = start + 1;
  return { start, end };
}
