// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
//
// This file is dual-licensed. As shipped inside the AGPL-licensed `evalution`
// core it is covered by AGPL-3.0-only; as bundled into an MIT-licensed SDK
// adapter package it is covered by MIT. Keep this file self-contained — it
// must import nothing from the rest of the core. See LICENSING.md.

/**
 * A reference to a prompt.
 *
 * `id` is interpreted as a globally-unique prompt ID unless `providerId` is
 * present, in which case `id` is scoped to that specific prompt provider. This
 * mirrors the OpenTelemetry attributes `evalution.prompt.id` (always present)
 * and `evalution.prompt.provider.id` (optional, scoping).
 */
export interface PromptID {
  /** The prompt ID — global unless {@link providerId} scopes it. */
  id: string;
  /** When set, {@link id} is scoped to this prompt provider. */
  providerId?: string;
  /** Positional arguments the prompt function was called with. */
  functionParameters?: unknown[];
  /**
   * The unresolved inputs the run was launched with — the recipe, not the
   * resolution.
   *
   * Replaying them is only exactly faithful for the `value` kind. A `resource`
   * re-runs its `create()`, producing an *equivalent* value rather than the
   * same one — a fresh handle, a newly seeded row — so a UI must present it as
   * something that will be re-created, never as a restored value.
   */
  functionInputs?: unknown[];
  /** The unresolved execute-parameter inputs, keyed by parameter name. */
  executeInputs?: Record<string, unknown>;
  /**
   * The prompt's parameter definitions as they stood when the run was
   * launched, so a replay can diff them against today's signature rather than
   * guess whether the recorded inputs still fit.
   */
  parameterDefinitions?: unknown[];
}

/**
 * Classification of a {@link Span}. See also:
 * - `lmnr.span.type` from https://laminar.sh/docs/tracing/otel
 * - `mlflow.spanType` from https://mlflow.org/docs/latest/genai/tracing/opentelemetry/attribute-mapping/#translated-span-attributes
 *
 * Mapped from `gen_ai.operation.name`.
 */
export type SpanKind = "LLM" | "TOOL" | "AGENT" | "EMBEDDING" | "DEFAULT";

/** A text segment within a multi-part {@link SpanMessage} content. */
export interface SpanTextPart {
  type: "text";
  text: string;
}

/** An image segment within a multi-part {@link SpanMessage} content. */
export interface SpanImagePart {
  type: "image";
  /** A URL, or base64/data-URI image data. */
  image: string;
  /** MIME type (e.g. `image/png`), when known. */
  mediaType?: string;
}

export type SpanMessageRole = string; // known values: "user" | "assistant" | "system" | "tool"

/** One segment of a multi-part {@link SpanMessage} content. */
export type SpanContentPart = SpanTextPart | SpanImagePart;

/**
 * A single message within an LLM span's input/output.
 *
 * `content` is a plain string for the common text-only case. It is an array
 * of {@link SpanContentPart} when the message carries non-text content (e.g.
 * an image) — the `string` form stays in the union so existing consumers and
 * already-stored rows keep working unchanged.
 */
export interface SpanMessage {
  role: SpanMessageRole;
  content: string | SpanContentPart[];
}

/** LLM-specific attributes attached to `LLM` spans. */
export interface LLMSpanDetails {
  // -- model info --
  provider?: string;
  model?: string;
  /** Model parameters (temperature, max_tokens, …). */
  modelParameters?: Record<string, unknown>;

  // -- prompt info --
  messages?: SpanMessage[];
  output?: string;

  // -- usage info --
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /**
   * Dollar cost of the call, broken down by token type, if known. The total
   * cost is `cost.prompt + cost.completion`.
   */
  cost?: {
    prompt: number;
    completion: number;
  };
}

export interface ToolSpanDetails {
  toolName: string;
  input: unknown;
  output?: unknown;
}

/**
 * A span in a {@link Trace}. Spans form a tree via {@link parentId}.
 * Durations are derived from `startTime` and `endTime`; an in-progress span has
 * no `endTime` yet.
 */
export interface Span {
  id: string;
  traceId: string;
  /** `undefined` for the root span of the trace. */
  parentId?: string;
  name: string;
  kind: SpanKind;
  /** Start timestamp in milliseconds since epoch. */
  startTime: number;
  /** End timestamp in milliseconds since epoch, or `undefined` while running. */
  endTime?: number;
  status?: "ok" | "error";
  /** Error message if `status` is `'error'`. */
  errorMessage?: string;
  /** Free-form attributes to show in the span's details pane. */
  attributes?: Record<string, unknown>;
  /** LLM-specific details (present for `chat`/`completion`/`embedding` spans). */
  llm?: LLMSpanDetails;
  /**
   * The prompt this span is attributed to, if any.
   *
   * Stored as emitted (`evalution.prompt.id` plus optional
   * `evalution.prompt.provider.id`): a {@link PromptID} whose `id` is global
   * unless `providerId` is set. The server resolves it against the prompt
   * registry to a provider-scoped reference when a trace is served.
   */
  prompt?: PromptID;
  tool?: ToolSpanDetails;
}

interface TraceBase {
  id: string;
  providerId?: string;
  name: string;
  /** Start timestamp (ms). */
  startTime: number;
  /** End timestamp (ms), or `undefined` while the trace is still running. */
  endTime?: number;
  status: "running" | "ok" | "error";
}

/**
 * Top-level trace for a single invocation (e.g. one prompt execution).
 */
export interface Trace extends TraceBase {
  /** Free-form attributes (e.g. prompt ID, function params). */
  attributes?: Record<string, unknown>;
}

/** Compact trace entry for listings (sidebar / `GET /api/traces`). */
export interface TraceSummary extends TraceBase {
  providerId: string;
  /** Number of spans currently associated with the trace. */
  spanCount: number;
}

/** A trace together with all of its spans. */
export interface TraceWithSpans {
  trace: Trace;
  spans: Span[];
}

/** Where an {@link Annotation} came from. */
export type AnnotationSource = "user" | "claude-code" | "codex";

/** What kind of note an {@link Annotation} records. */
export type AnnotationKind = "issue" | "good" | "note";

/**
 * A note attached to a trace, or to one specific span within it — e.g. a
 * reviewer flagging a bad tool call, or an agent leaving a note about a run
 * it just replayed.
 */
export interface Annotation {
  id: string;
  traceId: string;
  /** The span this annotation is attached to, or `undefined` for a trace-level annotation. */
  spanId?: string;
  kind: AnnotationKind;
  note: string;
  source: AnnotationSource;
  /** Creation timestamp (ms). */
  createdAt: number;
}

/** The kind of change that occurred to a trace. */
export type TraceChangeType = "add" | "update" | "remove";

/** Describes a single change emitted by `TraceProvider.watch`. */
export interface TraceChangeEvent {
  type: TraceChangeType;
  traceId: string;
}

/** Real-time event pushed over the per-trace SSE subscription. */
export type TraceStreamEvent =
  | { type: "span-start"; span: Span }
  | { type: "span-end"; span: Span }
  | { type: "span-update"; span: Span }
  | { type: "trace-update"; trace: Trace }
  | { type: "trace-end"; trace: Trace };

/** The change an annotation event describes. */
export type AnnotationEventOp = "insert" | "delete";

/** The event a per-trace annotation subscription delivers. */
export interface AnnotationEvent {
  type: "annotation";
  op: AnnotationEventOp;
  annotation: Annotation;
}

/**
 * Real-time event pushed over the per-trace SSE subscription, broadened
 * beyond span/trace lifecycle to also carry annotation changes — so a client
 * holding one `EventSource` open on a trace sees both without a second
 * connection. See `specs/trace-workshopping.md` §C.2.
 */
export type TraceLiveEvent = TraceStreamEvent | AnnotationEvent;

/** Information about a registered trace provider, returned by `GET /api/trace-providers`. */
export interface TraceProviderInfo {
  id: string;
  displayName?: string;
  description?: string;
}
