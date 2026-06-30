// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
//
// This file is dual-licensed. As shipped inside the AGPL-licensed `evalution`
// core it is covered by AGPL-3.0-only; as bundled into an MIT-licensed SDK
// adapter package it is covered by MIT. Keep this file self-contained — it
// must import nothing from the rest of the core (only sibling dual-licensed
// `src/trace/` modules). See LICENSING.md.

import type { TraceProvider } from "./trace-provider.ts";
import type {
  Span,
  Trace,
  TraceChangeEvent,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "./trace-types.ts";

/**
 * The write side of a {@link TraceProvider}. A {@link TraceIngestor} feeds
 * normalized spans in; the sink owns root detection, trace creation, and
 * event emission.
 */
export interface TraceSink {
  /**
   * Records a span start. Creates a `running` trace for a new root. Returns
   * the stored (merged) span. Emits `span-start` (+ watch `add` for a new
   * trace).
   */
  recordSpanStart(span: Span): Promise<Span>;

  /**
   * Records a span end. For a root span, finalizes the trace and emits
   * `trace-end` (+ watch `update`). Returns the stored (merged) span.
   */
  recordSpanEnd(span: Span): Promise<Span>;

  /**
   * Finalizes a trace as `error` when execution fails before any span is
   * produced (e.g. a bad model id throws before `onStart`).
   */
  failTrace(traceId: string, errorMessage: string): Promise<void>;
}

/**
 * Source-agnostic base class for a {@link TraceProvider}. Owns storage
 * delegation, subscriptions, watchers, and the generic trace lifecycle that
 * every concrete provider shares, regardless of how spans are produced.
 *
 * Subclasses implement the abstract storage hooks; ingestion is handled by
 * one or more {@link TraceIngestor}s that call {@link recordSpanStart} /
 * {@link recordSpanEnd} / {@link failTrace} on this instance (via
 * {@link TraceSink}).
 */
export abstract class BaseTraceProvider implements TraceProvider, TraceSink {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;

  private subscribers = new Map<
    string,
    Set<(event: TraceStreamEvent) => void>
  >();
  private watchers = new Set<(event: TraceChangeEvent) => void>();

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
   * Stores a span, merging it into any existing span with the same ID (via
   * the `mergeSpans` helper). Returns the resulting stored span so callers
   * can stream the merged view rather than the partial snapshot they passed
   * in.
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

  async recordSpanStart(span: Span): Promise<Span> {
    const isRoot = !span.parentId;
    if (isRoot && !(await this.hasTrace(span.traceId))) {
      const trace: Trace = {
        id: span.traceId,
        providerId: this.id,
        name: span.name,
        startTime: span.startTime,
        status: "running",
        attributes: { ...span.attributes },
      };
      await this.addOrUpdateTrace(trace);
      this.emitChange({ type: "add", traceId: span.traceId });
    }

    const stored = await this.addOrUpdateSpan(span);
    this.emitStream(span.traceId, { type: "span-start", span: stored });
    return stored;
  }

  async recordSpanEnd(span: Span): Promise<Span> {
    const stored = await this.addOrUpdateSpan(span);
    this.emitStream(span.traceId, { type: "span-end", span: stored });

    if (!stored.parentId) {
      const existing = await this.getTraceWithoutSpans(span.traceId);
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
        this.emitStream(span.traceId, { type: "trace-end", trace: endedTrace });
        this.emitChange({ type: "update", traceId: span.traceId });
      }
    }
    return stored;
  }

  async failTrace(traceId: string, errorMessage: string): Promise<void> {
    const existing = await this.getTraceWithoutSpans(traceId);
    if (!existing) return;
    const failed: Trace = {
      ...existing,
      endTime: Date.now(),
      status: "error",
      attributes: { ...existing.attributes, errorMessage },
    };
    await this.addOrUpdateTrace(failed);
    this.emitStream(traceId, { type: "trace-end", trace: failed });
    this.emitChange({ type: "update", traceId });
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
}
