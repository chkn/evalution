// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Span, Trace, TraceSummary } from "../shared/types.ts";
import { mergeSpans } from "./span-merge.ts";
import { rollupSpans } from "./span-rollup.ts";
import type { TraceIngestor } from "./trace-ingestor.ts";
import { BaseTraceProvider } from "./trace-sink.ts";

/**
 * In-memory {@link TraceProvider}, populated by one or more
 * {@link TraceIngestor}s, each connected via `ingestor.addSink(provider)`.
 */
export class MemoryTraceProvider extends BaseTraceProvider {
  private traces = new Map<string, Trace>();
  private spansByTrace = new Map<string, Span[]>();

  constructor({
    id = "memory",
    displayName = "In-Memory Traces",
    description = "Stores traces in memory for the current process.",
  }: {
    id?: string;
    displayName?: string;
    description?: string;
  } = {}) {
    super({ id, displayName, description });
  }

  async getAllTraces(): Promise<TraceSummary[]> {
    const summaries = Array.from(this.traces.values()).map(t => {
      const spans = this.spansByTrace.get(t.id) ?? [];
      return {
        id: t.id,
        providerId: this.id,
        name: t.name,
        startTime: t.startTime,
        endTime: t.endTime,
        status: t.status,
        spanCount: spans.length,
        ...rollupSpans(spans),
        // This provider has no annotation store (it doesn't implement
        // `createAnnotation`/`listAnnotations`), so there's never anything to count.
        annotationCounts: { issue: 0, good: 0, note: 0 },
      };
    });
    summaries.sort((a, b) => b.startTime - a.startTime);
    return summaries;
  }

  async hasTrace(traceId: string): Promise<boolean> {
    return this.traces.has(traceId);
  }

  protected async getTraceWithoutSpans(
    traceId: string,
  ): Promise<Trace | undefined> {
    return this.traces.get(traceId);
  }

  protected async getTraceSpans(traceId: string): Promise<Span[]> {
    return this.spansByTrace.get(traceId) ?? [];
  }

  protected async addOrUpdateTrace(trace: Trace): Promise<void> {
    this.traces.set(trace.id, trace);
  }

  protected async addOrUpdateSpan(span: Span): Promise<Span> {
    let list = this.spansByTrace.get(span.traceId);
    if (!list) {
      list = [];
      this.spansByTrace.set(span.traceId, list);
    }
    const idx = list.findIndex(s => s.id === span.id);
    if (idx >= 0) {
      const merged = mergeSpans(list[idx], span);
      list[idx] = merged;
      return merged;
    }
    list.push(span);
    return span;
  }
}
