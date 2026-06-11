// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  Span,
  Trace,
  TraceSummary,
} from '../shared/types.ts';
import { BaseOTelTraceProvider, mergeSpans } from './base-otel-trace-provider.ts';

/**
 * In-memory {@link TraceProvider} populated by OpenTelemetry spans.
 *
 * Register the processor returned by {@link getSpanProcessor} on a
 * `BasicTracerProvider` (from `@opentelemetry/sdk-trace-base`).
 */
export class MemoryTraceProvider extends BaseOTelTraceProvider {
  private traces = new Map<string, Trace>();
  private spansByTrace = new Map<string, Span[]>();

  constructor({
    id = 'memory',
    displayName = 'In-Memory Traces',
    description = 'Stores OpenTelemetry spans in memory for the current process.',
  }: { id?: string; displayName?: string; description?: string } = {}) {
    super({
      id,
      displayName,
      description,
    });
  }

  async getAllTraces(): Promise<TraceSummary[]> {
    const summaries = Array.from(this.traces.values()).map(t => ({
      id: t.id,
      providerId: this.id,
      name: t.name,
      startTime: t.startTime,
      endTime: t.endTime,
      status: t.status,
      spanCount: this.spansByTrace.get(t.id)?.length ?? 0,
    }));
    summaries.sort((a, b) => b.startTime - a.startTime);
    return summaries;
  }

  async hasTrace(traceId: string): Promise<boolean> {
    return this.traces.has(traceId);
  }

  protected async getTraceWithoutSpans(traceId: string): Promise<Trace | undefined> {
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
