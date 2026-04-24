import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { PromptProvider } from '../prompt/prompt-provider.ts';
import type {
  SpanKind,
  TraceChangeEvent,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from '../shared/types.ts';

/**
 * Attribute name a span can set to pick one of our {@link SpanKind} values.
 * Falls back to `'DEFAULT'` when absent or unrecognised.
 */
export const SPAN_KIND_ATTRIBUTE = 'evalution.span.type';

/**
 * Attribute name a span can set to link itself to a specific {@link PromptProvider}.
 */
export const PROMPT_PROVIDER_ID_ATTRIBUTE = 'evalution.prompt.provider.id';

/**
 * Attribute name a span can set to link itself to a specific prompt.
 */
export const PROMPT_ID_ATTRIBUTE = 'evalution.prompt.id';

/**
 * Attribute name a span can set to give a human-readable name to the prompt.
 */
export const PROMPT_NAME_ATTRIBUTE = 'gen_ai.prompt.name';

/**
 * A read-only store of execution traces that the playground can display and
 * subscribe to in real time. Implement this interface to integrate a tracing
 * backend (in-memory, OpenTelemetry collector, LangSmith, Langfuse, …).
 *
 * Traces and spans are created via the OpenTelemetry API
 * (`@opentelemetry/api`). A `TraceProvider` implementation's job is to expose
 * the traces a backend knows about; populating the store from OTel spans is
 * an implementation detail (e.g. by registering a
 * `@opentelemetry/sdk-trace-base` `SpanProcessor`).
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
   * `undefined` when the trace is unknown.
   */
  getTrace(traceId: string): Promise<TraceWithSpans | undefined>;

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
   * Registers a callback invoked whenever a trace is added, updated, or
   * removed. Used by the sidebar to stay in sync without polling.
   *
   * Optional — providers that cannot detect live changes may omit it.
   *
   * @returns A no-argument function that unregisters the watcher.
   */
  watch?(callback: (event: TraceChangeEvent) => void): () => void;

  /**
   * Returns a `SpanProcessor` (from `@opentelemetry/sdk-trace-base`) that
   * feeds OpenTelemetry spans into this provider's store. The playground
   * registers it on a shared `BasicTracerProvider` so spans produced by the
   * server's tracer land here.
   *
   * Optional — providers backed by an external backend (LangSmith, a
   * collector, …) typically receive spans out-of-band and can omit this.
   */
  getSpanProcessor?(): SpanProcessor;
}
