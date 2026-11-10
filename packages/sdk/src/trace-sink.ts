// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import type { Span } from "./trace-types.ts";

/**
 * The write side of a `TraceProvider`. A {@link TraceIngestor} feeds
 * normalized spans in; the sink owns root detection, trace creation, and
 * event emission.
 */
export interface TraceSink {
  /**
   * Records a span start. Creates a `running` trace for a new root. Returns
   * the stored (merged) span. Emits `span-start` (+ watch `add` for a new
   * trace).
   */
  recordSpanStart(span: Span): Promise<Span>;

  /**
   * Records a span end. For a root span, finalizes the trace and emits
   * `trace-end` (+ watch `update`). Returns the stored (merged) span.
   */
  recordSpanEnd(span: Span): Promise<Span>;

  /**
   * Finalizes a trace as `error` when execution fails before any span is
   * produced (e.g. a bad model id throws before `onStart`).
   */
  failTrace(traceId: string, errorMessage: string): Promise<void>;

  /**
   * Optional: resolves once everything recorded so far has been delivered,
   * for a sink that records in the background (e.g. `HttpTraceSink`).
   */
  flush?(): Promise<void>;
}

export function isTraceSink(o: any): o is TraceSink {
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.recordSpanStart === "function" &&
    typeof o.recordSpanEnd === "function" &&
    typeof o.failTrace === "function"
  );
}
