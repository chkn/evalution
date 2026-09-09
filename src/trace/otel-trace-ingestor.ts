// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { HrTime } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type {
  Span as OTelSpan,
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { llmAndPrompt, mapStatus, readKind } from "./otel-attributes.ts";
import { BaseTraceIngestor, type TraceIngestor } from "./trace-ingestor.ts";
import type { Span } from "./trace-types.ts";

function hrTimeToMs(time: HrTime): number {
  return time[0] * 1000 + time[1] / 1e6;
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
