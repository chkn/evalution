// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Folding a trace's live events into what's known of it so far — shared by
 * the trace view and by trace views' frames, which keep their own copy of
 * the trace from the same events (`specs/trace-visualizers.md` §C.1).
 */

import type { Span, Trace, TraceStreamEvent } from "../trace/trace-types.ts";

/** A trace as far as it's known: `trace` is `null` until it's loaded. */
export interface TraceState<T extends Trace | null = Trace | null> {
  trace: T;
  spans: Span[];
}

/**
 * `prev` with `event` applied: a span event adds or replaces its span, and a
 * trace event replaces the trace. Anything else leaves it as it was.
 */
export function applyStreamEvent<S extends TraceState>(
  prev: S,
  event: TraceStreamEvent | { type: string },
): S {
  const e = event as TraceStreamEvent;
  switch (e.type) {
    case "span-start":
    case "span-end":
    case "span-update": {
      const existing = prev.spans.findIndex(s => s.id === e.span.id);
      const spans =
        existing >= 0
          ? prev.spans.map((s, i) => (i === existing ? e.span : s))
          : [...prev.spans, e.span];
      return { ...prev, spans };
    }
    case "trace-update":
    case "trace-end":
      return { ...prev, trace: e.trace };
    default:
      return prev;
  }
}
