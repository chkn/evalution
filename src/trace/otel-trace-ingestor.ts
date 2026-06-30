// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { HrTime, SpanStatus } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type {
  Span as OTelSpan,
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { otelOperationToSpanKind } from "../shared/helpers.ts";
import { SPAN_KIND_ATTRIBUTE } from "./prompt-tracer.ts";
import { BaseTraceIngestor, type TraceIngestor } from "./trace-ingestor.ts";
import type {
  LLMSpanDetails,
  PromptID,
  Span,
  SpanKind,
  SpanMessage,
} from "./trace-types.ts";

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
 * {@link TraceIngestor} populated by OpenTelemetry spans. Register the
 * processor returned by {@link getSpanProcessor} on a `BasicTracerProvider`
 * (from `@opentelemetry/sdk-trace-base`).
 *
 * Because OpenTelemetry is a single process-global pipeline, at most one
 * `OTelTraceIngestor` should be active per server — {@link isRedundant}
 * reports any other instance redundant so server wiring can consolidate.
 */
export class OTelTraceIngestor extends BaseTraceIngestor {
  private spanPromises = new Map<string, Promise<void>>();

  isRedundant(other: TraceIngestor): boolean {
    return other instanceof OTelTraceIngestor;
  }

  /**
   * Returns a `SpanProcessor` that funnels every OpenTelemetry span the
   * caller's tracer produces into this ingestor's sinks.
   */
  getSpanProcessor(): SpanProcessor {
    return {
      onStart: (span: OTelSpan) => {
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
    const parentId =
      parentCtx && parentCtx.traceId === traceId ? parentCtx.spanId : undefined;

    // A root span (no parent) implicitly creates its `running` trace via
    // `recordSpanStart`, so no separate pre-creation step is needed here.
    const ourSpan: Span = {
      id: spanId,
      traceId,
      parentId,
      name: span.name,
      kind: readKind(span.attributes),
      startTime: hrTimeToMs(span.startTime),
      attributes: { ...span.attributes },
      ...llmAndPrompt(span.attributes),
    };
    await this.recordSpanStart(ourSpan);
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
    await this.recordSpanEnd(ended);
  }

  /**
   * Waits for every in-flight `onStart`/`onEnd` handler to settle. Used by
   * tests to deterministically assert on the resulting trace store.
   */
  async drainPendingHandlers(): Promise<void> {
    while (this.spanPromises.size > 0) {
      await Promise.all([...this.spanPromises.values()]);
    }
  }
}
