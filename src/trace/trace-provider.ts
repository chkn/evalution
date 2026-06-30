// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  TraceChangeEvent,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "../shared/types.ts";

export {
  createTracerForPrompt,
  PROMPT_ID_ATTRIBUTE,
  PROMPT_NAME_ATTRIBUTE,
  PROMPT_PROVIDER_ID_ATTRIBUTE,
  SPAN_KIND_ATTRIBUTE,
} from "./prompt-tracer.ts";

/**
 * A read-only store of execution traces that the playground can display and
 * subscribe to in real time. Implement this interface to integrate a tracing
 * backend.
 *
 * `TraceProvider` is a pure read interface — populating the store is the job
 * of a `TraceIngestor`, which feeds normalized spans into the provider's
 * write side (`TraceSink`, implemented by `BaseTraceProvider`).
 */
export interface TraceProvider {
  /**
   * Uniquely identifies this instance, even when multiple providers of the
   * same type are used.
   */
  readonly id: string;

  /** Human-readable name shown when choosing between providers. */
  readonly displayName?: string;

  /** Short description of what this provider offers. */
  readonly description?: string;

  /**
   * Returns compact summaries for every trace known to this provider, newest
   * first. Used to populate the Traces sidebar.
   */
  getAllTraces(): Promise<TraceSummary[]>;

  /**
   * Returns the trace with the given ID together with all of its spans, or
   * `undefined` when the trace is unknown.
   */
  getTrace(traceId: string): Promise<TraceWithSpans | undefined>;

  /**
   * Subscribes to real-time updates for a specific trace. The callback is
   * invoked for every {@link Span} change on this trace, for as long as the
   * returned cleanup function has not been called.
   *
   * Optional — providers that cannot track live changes may omit it.
   *
   * @returns A no-argument function that cancels the subscription.
   */
  subscribeTrace?(
    traceId: string,
    callback: (event: TraceStreamEvent) => void,
  ): () => void;

  /**
   * Registers a callback invoked whenever a trace is added, updated, or
   * removed. Used by the sidebar to stay in sync without polling.
   *
   * Optional — providers that cannot detect live changes may omit it.
   *
   * @returns A no-argument function that unregisters the watcher.
   */
  watch?(callback: (event: TraceChangeEvent) => void): () => void;
}
