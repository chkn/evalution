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
}

/**
 * Classification of a {@link Span}. See also:
 * - `lmnr.span.type` from https://laminar.sh/docs/tracing/otel
 * - `mlflow.spanType` from https://mlflow.org/docs/latest/genai/tracing/opentelemetry/attribute-mapping/#translated-span-attributes
 *
 * Mapped from `gen_ai.operation.name`.
 */
export type SpanKind = "LLM" | "TOOL" | "AGENT" | "EMBEDDING" | "DEFAULT";

/** A single message within an LLM span's input/output. */
export interface SpanMessage {
  role: string;
  content: string;
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
  /** Dollar cost of the call, if known. */
  cost?: number;
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

/** Information about a registered trace provider, returned by `GET /api/trace-providers`. */
export interface TraceProviderInfo {
  id: string;
  displayName?: string;
  description?: string;
}
