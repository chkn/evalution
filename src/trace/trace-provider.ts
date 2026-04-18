import type {
  BeginPromptTraceInfo,
  Trace,
  TraceChangeEvent,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from '../shared/types.ts';

/**
 * A source of execution traces that the playground can display and subscribe
 * to in real time. Implement this interface to integrate a tracing backend
 * (in-memory, OpenTelemetry collector, LangSmith, Langfuse, …).
 *
 * The playground invokes {@link beginPromptTrace} at the start of every
 * prompt execution, then streams the resulting trace's {@link Span}s to the
 * trace tab via {@link subscribeTrace}.
 */
export interface TraceProvider {
  /** Uniquely identifies this provider when multiple providers are used. */
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
   * `null` when the trace is unknown.
   */
  getTrace(traceId: string): Promise<TraceWithSpans | null>;

  /**
   * Subscribes to real-time updates for a specific trace. The callback is
   * invoked for every {@link Span} change on this trace, for as long as the
   * returned cleanup function has not been called.
   *
   * @returns A no-argument function that cancels the subscription.
   */
  subscribeTrace(
    traceId: string,
    callback: (event: TraceStreamEvent) => void
  ): () => void;

  /**
   * Registers a new trace for the given prompt execution and returns its ID
   * immediately. The trace is populated asynchronously — subscribers should
   * attach via {@link subscribeTrace} to follow updates.
   *
   * @param info - Metadata describing what is being executed.
   * @returns The fresh {@link Trace} so the caller can echo its ID back to
   * the client right away.
   */
  beginPromptTrace(info: BeginPromptTraceInfo): Promise<Trace>;

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
