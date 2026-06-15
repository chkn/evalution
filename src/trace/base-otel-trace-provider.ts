// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Context, HrTime, SpanStatus } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type {
  Span as OTelSpan,
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { otelOperationToSpanKind } from "../shared/helpers.ts";
import type {
  LLMSpanDetails,
  PromptID,
  Span,
  SpanKind,
  SpanMessage,
  Trace,
  TraceChangeEvent,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "../shared/types.ts";
import { SPAN_KIND_ATTRIBUTE, type TraceProvider } from "./trace-provider.ts";

const KNOWN_KINDS: readonly SpanKind[] = [
  "LLM",
  "TOOL",
  "AGENT",
  "EMBEDDING",
  "DEFAULT",
];

function hrTimeToMs(time: HrTime): number {
  return time[0] * 1000 + time[1] / 1e6;
}

function readKind(attributes: Record<string, unknown>): SpanKind {
  const raw =
    (attributes[SPAN_KIND_ATTRIBUTE] as SpanKind | undefined) ??
    otelOperationToSpanKind(attributes["gen_ai.operation.name"]);
  return typeof raw === "string" && KNOWN_KINDS.includes(raw) ? raw : "DEFAULT";
}

const PARAM_ATTRIBUTES = [
  "gen_ai.request.temperature",
  "gen_ai.request.max_tokens",
  "gen_ai.request.top_k",
  "gen_ai.request.top_p",
  "gen_ai.request.frequency_penalty",
  "gen_ai.request.presence_penalty",
  "gen_ai.request.seed",
  "gen_ai.request.stop_sequences",
  "gen_ai.request.choice.count",
] as const;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function parseMessages(v: unknown): SpanMessage[] | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((msg: unknown) => {
      if (!msg || typeof msg !== "object") return [];
      const m = msg as Record<string, unknown>;
      const role = str(m.role) ?? "unknown";
      const content = m.content;
      if (typeof content === "string") return [{ role, content }];
      if (Array.isArray(content)) {
        const text = content
          .filter(
            (c): c is Record<string, unknown> => !!c && typeof c === "object",
          )
          .filter(c => c.type === "text")
          .map(c => str(c.text) ?? "")
          .join("");
        return text ? [{ role, content: text }] : [];
      }
      return [];
    });
  } catch {
    return undefined;
  }
}

function parseOutput(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .flatMap((msg: unknown) => {
        if (!msg || typeof msg !== "object") return [];
        const m = msg as Record<string, unknown>;
        const content = m.content;
        if (typeof content === "string") return [content];
        if (Array.isArray(content)) {
          return content
            .filter(
              (c): c is Record<string, unknown> => !!c && typeof c === "object",
            )
            .filter(c => c.type === "text")
            .map(c => str(c.text) ?? "");
        }
        return [];
      })
      .join("\n");
  } catch {
    return undefined;
  }
}

function readLLM(
  attributes: Record<string, unknown>,
): LLMSpanDetails | undefined {
  const provider =
    str(attributes["gen_ai.provider.name"]) ?? str(attributes["gen_ai.system"]);
  const model =
    str(attributes["gen_ai.response.model"]) ??
    str(attributes["gen_ai.request.model"]);
  // Token usage: OTel GenAI semconv keys, falling back to the Vercel AI SDK's.
  const promptTokens =
    num(attributes["gen_ai.usage.input_tokens"]) ??
    num(attributes["ai.usage.promptTokens"]);
  const completionTokens =
    num(attributes["gen_ai.usage.output_tokens"]) ??
    num(attributes["ai.usage.completionTokens"]);
  // Input/output: the OTel GenAI semconv uses `gen_ai.{input,output}.messages`,
  // but the Vercel AI SDK instead emits `ai.prompt.messages` (a JSON message
  // array) and `ai.response.text` (a plain string). Support both.
  const messages = parseMessages(
    attributes["gen_ai.input.messages"] ?? attributes["ai.prompt.messages"],
  );
  const output =
    parseOutput(attributes["gen_ai.output.messages"]) ??
    str(attributes["ai.response.text"]);

  const paramEntries = PARAM_ATTRIBUTES.map(
    key => [key.replace("gen_ai.request.", ""), attributes[key]] as const,
  ).filter(([, v]) => v !== undefined);
  const modelParameters =
    paramEntries.length > 0 ? Object.fromEntries(paramEntries) : undefined;

  const totalTokens =
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined;

  if (
    !provider &&
    !model &&
    !promptTokens &&
    !completionTokens &&
    !messages &&
    !output &&
    !modelParameters
  ) {
    return undefined;
  }

  return {
    ...(provider && { provider }),
    ...(model && { model }),
    ...(messages && { messages }),
    ...(output && { output }),
    ...(promptTokens !== undefined && { promptTokens }),
    ...(completionTokens !== undefined && { completionTokens }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(modelParameters && { modelParameters }),
  };
}

function llmAndPrompt(attributes: Record<string, unknown>): Partial<Span> {
  const llm = readLLM(attributes);
  // Store the prompt reference exactly as emitted: `id` is global unless a
  // provider id scopes it. Resolution to a concrete prompt happens later, when
  // a trace is served, so the stored (possibly global) id stays stable.
  const id = str(attributes["evalution.prompt.id"]);
  const providerId = str(attributes["evalution.prompt.provider.id"]);
  const prompt: PromptID | undefined = id
    ? { id, ...(providerId && { providerId }) }
    : undefined;
  return {
    ...(llm && { llm }),
    ...(prompt && { prompt }),
  };
}

function mapStatus(status: SpanStatus): "ok" | "error" | undefined {
  if (status.code === SpanStatusCode.ERROR) return "error";
  if (status.code === SpanStatusCode.OK) return "ok";
  return undefined;
}

/**
 * Merges a later snapshot of a span into an earlier one.
 *
 * OpenTelemetry reports each span twice — at `onStart` (creation-time
 * attributes only) and at `onEnd` (the full set) — and the two snapshots can
 * carry complementary data. This unions their `attributes` and lets any
 * *defined* field on `incoming` update `existing`, so nothing recorded at start
 * is lost when the span ends, and end-only fields (status, timings, token
 * usage, …) are filled in.
 */
export function mergeSpans(existing: Span, incoming: Span): Span {
  const merged = { ...existing } as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value;
  }
  const result = merged as unknown as Span;
  if (existing.attributes || incoming.attributes) {
    result.attributes = { ...existing.attributes, ...incoming.attributes };
  }
  return result;
}

/**
 * Base class for a {@link TraceProvider} populated by OpenTelemetry spans.
 *
 * Register the processor returned by {@link getSpanProcessor} on a
 * `BasicTracerProvider` (from `@opentelemetry/sdk-trace-base`).
 */
export abstract class BaseOTelTraceProvider implements TraceProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;

  private subscribers = new Map<
    string,
    Set<(event: TraceStreamEvent) => void>
  >();
  private watchers = new Set<(event: TraceChangeEvent) => void>();
  private spanPromises = new Map<string, Promise<void>>();

  constructor(options: {
    id: string;
    displayName: string;
    description: string;
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.description = options.description;
  }

  abstract getAllTraces(): Promise<TraceSummary[]>;

  abstract hasTrace(traceId: string): Promise<boolean>;

  protected abstract getTraceWithoutSpans(
    traceId: string,
  ): Promise<Trace | undefined>;

  protected abstract getTraceSpans(traceId: string): Promise<Span[]>;

  protected abstract addOrUpdateTrace(trace: Trace): Promise<void>;

  /**
   * Stores a span, merging it into any existing span with the same ID (via the
   * internal `mergeSpans` helper). Returns the resulting stored span so callers can
   * stream the merged view rather than the partial snapshot they passed in.
   */
  protected abstract addOrUpdateSpan(span: Span): Promise<Span>;

  async getTrace(traceId: string): Promise<TraceWithSpans | undefined> {
    const trace = await this.getTraceWithoutSpans(traceId);
    if (!trace) return undefined;
    const spans = await this.getTraceSpans(traceId);
    return { trace, spans };
  }

  subscribeTrace(
    traceId: string,
    callback: (event: TraceStreamEvent) => void,
  ): () => void {
    let set = this.subscribers.get(traceId);
    if (!set) {
      set = new Set();
      this.subscribers.set(traceId, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.subscribers.delete(traceId);
    };
  }

  watch(callback: (event: TraceChangeEvent) => void): () => void {
    this.watchers.add(callback);
    return () => {
      this.watchers.delete(callback);
    };
  }

  /**
   * Returns a `SpanProcessor` that funnels every OpenTelemetry span the
   * caller's tracer produces into this provider's in-memory store.
   */
  getSpanProcessor(): SpanProcessor {
    return {
      onStart: (span: OTelSpan, _parentContext: Context) => {
        const spanId = span.spanContext().spanId;
        const p = this.handleStart(span).catch(console.error);
        this.spanPromises.set(spanId, p);
        p.finally(() => this.spanPromises.delete(spanId));
      },
      onEnd: (span: ReadableSpan) => {
        const spanId = span.spanContext().spanId;
        const startP = this.spanPromises.get(spanId) ?? Promise.resolve();
        const p = startP.then(() => this.handleEnd(span)).catch(console.error);
        this.spanPromises.set(spanId, p);
        p.finally(() => this.spanPromises.delete(spanId));
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
  }

  private async handleStart(span: OTelSpan): Promise<void> {
    const ctx = span.spanContext();
    const traceId = ctx.traceId;
    const spanId = ctx.spanId;
    const parentCtx = span.parentSpanContext;
    const isRoot = !parentCtx || parentCtx.traceId !== traceId;

    if (isRoot && !(await this.hasTrace(traceId))) {
      const startTime = hrTimeToMs(span.startTime);
      const trace: Trace = {
        id: traceId,
        providerId: this.id,
        name: span.name,
        startTime,
        status: "running",
        attributes: { ...span.attributes },
      };
      await this.addOrUpdateTrace(trace);
      this.emitChange({ type: "add", traceId });
    }

    const ourSpan: Span = {
      id: spanId,
      traceId,
      parentId:
        parentCtx && parentCtx.traceId === traceId
          ? parentCtx.spanId
          : undefined,
      name: span.name,
      kind: readKind(span.attributes),
      startTime: hrTimeToMs(span.startTime),
      attributes: { ...span.attributes },
      ...llmAndPrompt(span.attributes),
    };
    const stored = await this.addOrUpdateSpan(ourSpan);
    this.emitStream(traceId, { type: "span-start", span: stored });
  }

  private async handleEnd(span: ReadableSpan): Promise<void> {
    const ctx = span.spanContext();
    const traceId = ctx.traceId;
    const spanId = ctx.spanId;

    const ended: Span = {
      id: spanId,
      traceId,
      parentId:
        span.parentSpanContext && span.parentSpanContext.traceId === traceId
          ? span.parentSpanContext.spanId
          : undefined,
      name: span.name,
      kind: readKind(span.attributes),
      startTime: hrTimeToMs(span.startTime),
      endTime: hrTimeToMs(span.endTime),
      status: mapStatus(span.status),
      errorMessage:
        span.status.code === SpanStatusCode.ERROR
          ? span.status.message
          : undefined,
      attributes: { ...span.attributes },
      ...llmAndPrompt(span.attributes),
    };
    const stored = await this.addOrUpdateSpan(ended);
    this.emitStream(traceId, { type: "span-end", span: stored });

    // If span is root span, update trace as well
    if (!stored.parentId) {
      const existing = await this.getTraceWithoutSpans(traceId);
      if (existing) {
        const endedTrace: Trace = {
          ...existing,
          endTime: stored.endTime,
          status: stored.status === "error" ? "error" : "ok",
          // Refresh trace attributes from the root span's final (merged) set —
          // the root may have accrued attributes after the trace was created.
          attributes: { ...existing.attributes, ...stored.attributes },
        };
        await this.addOrUpdateTrace(endedTrace);
        this.emitStream(traceId, { type: "trace-end", trace: endedTrace });
        this.emitChange({ type: "update", traceId });
      }
    }
  }

  private emitStream(traceId: string, event: TraceStreamEvent): void {
    const set = this.subscribers.get(traceId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(event);
      } catch (err) {
        console.error("Trace subscriber threw:", err);
      }
    }
  }

  private emitChange(event: TraceChangeEvent): void {
    for (const cb of this.watchers) {
      try {
        cb(event);
      } catch (err) {
        console.error("Trace watcher threw:", err);
      }
    }
  }

  async drainPendingHandlers(): Promise<void> {
    while (this.spanPromises.size > 0) {
      await Promise.all([...this.spanPromises.values()]);
    }
  }
}
