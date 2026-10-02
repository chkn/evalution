// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  Annotation,
  AnnotationChanges,
  AnnotationEvent,
  AnnotationEventOp,
  TraceChangeEvent,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "../shared/types.ts";
import type { SqlQueryOptions, SqlQueryResult } from "./db/read-only-query.ts";

export {
  createTracerForPrompt,
  PROMPT_ID_ATTRIBUTE,
  PROMPT_INPUTS_ATTRIBUTE,
  PROMPT_NAME_ATTRIBUTE,
  PROMPT_PROVIDER_ID_ATTRIBUTE,
  PROMPT_VARIATION_ATTRIBUTE,
  PROMPT_VERSION_ATTRIBUTE,
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

  /**
   * Permanently deletes a trace along with its spans and annotations, and
   * notifies {@link watch}ers with a `remove` event. Returns `false` if the trace
   * doesn't exist.
   *
   * Optional — a provider backed by a read-only source omits it, and the REST
   * route in `src/server/api-routes.ts` treats its absence as "not
   * supported" (405).
   */
  deleteTrace?(traceId: string): Promise<boolean>;

  /**
   * Runs one read-only SQL query (a `SELECT`) against this provider's
   * store and returns the rows — the ad-hoc counterpart to
   * {@link getAllTraces}, for questions a summary can't answer. The schema the
   * query is written against is {@link getQuerySchema}'s. Writes are refused.
   *
   * Optional — a provider not backed by SQL omits it, and the REST and MCP
   * handlers report "not supported".
   */
  query?(sql: string, options?: SqlQueryOptions): Promise<SqlQueryResult>;

  /**
   * Describes the tables {@link query} runs against, as annotated SQL DDL.
   * Present exactly when {@link query} is.
   */
  getQuerySchema?(): string;

  // ── Annotations — all optional; a provider with no annotation store
  // (e.g. `MemoryTraceProvider`) simply omits every member below, and the
  // REST handlers in `src/server/handlers/annotations.ts` treat their
  // absence as "not supported" (404/405) rather than assuming any of them
  // exist. See `specs/trace-workshopping.md` §B.2/§0e.

  /** Lists every annotation on a trace, oldest first. */
  listAnnotations?(traceId: string): Promise<Annotation[]>;

  /** Creates a new annotation, minting its `id`/`createdAt`. */
  createAnnotation?(
    input: Omit<Annotation, "id" | "createdAt">,
  ): Promise<Annotation>;

  /**
   * Changes an annotation's `kind` and/or `note`, returning it as updated, or
   * `undefined` if it doesn't exist.
   */
  updateAnnotation?(
    id: string,
    changes: AnnotationChanges,
  ): Promise<Annotation | undefined>;

  /** Deletes an annotation by id. A no-op if it doesn't exist. */
  deleteAnnotation?(id: string): Promise<void>;

  /**
   * Subscribes to annotation changes on a specific trace — the counterpart
   * to {@link subscribeTrace} that a client's per-trace SSE connection also
   * opens, so both ride the same stream. Callers (the annotation REST
   * handlers) invoke {@link emitAnnotation} after a successful
   * create/update/delete; this only delivers what's explicitly emitted.
   *
   * @returns A no-argument function that cancels the subscription.
   */
  subscribeAnnotations?(
    traceId: string,
    callback: (event: AnnotationEvent) => void,
  ): () => void;

  /**
   * Notifies this trace's {@link subscribeAnnotations} subscribers of an
   * annotation change. Called by the annotation REST handlers immediately
   * after {@link createAnnotation}/{@link updateAnnotation}/{@link deleteAnnotation}
   * succeeds — the
   * provider itself never calls this on its own.
   */
  emitAnnotation?(
    traceId: string,
    op: AnnotationEventOp,
    annotation: Annotation,
  ): void;
}
