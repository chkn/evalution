// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  Annotation,
  AnnotationEvent,
  AnnotationEventOp,
  Span,
  Trace,
  TraceChangeEvent,
  TraceSink,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "@evalution/sdk";
import type { TraceProvider } from "./trace-provider.ts";

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

  protected subscribers = new Map<
    string,
    Set<(event: TraceStreamEvent) => void>
  >();
  private watchers = new Set<(event: TraceChangeEvent) => void>();
  private annotationSubscribers = new Map<
    string,
    Set<(event: AnnotationEvent) => void>
  >();

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
   * Removes a trace together with its spans and annotations. Only called for
   * a trace that {@link hasTrace} confirmed exists.
   */
  protected abstract removeTrace(traceId: string): Promise<void>;

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

  async deleteTrace(traceId: string): Promise<boolean> {
    if (!(await this.hasTrace(traceId))) return false;
    await this.removeTrace(traceId);
    this.emitChange({ type: "remove", traceId });
    return true;
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
   * Generic pub-sub for annotation changes — every subclass gets a working
   * implementation "for free", even one with no annotation store of its own
   * (e.g. `MemoryTraceProvider`): nothing is ever delivered unless a caller
   * (the annotation REST handlers) explicitly calls {@link emitAnnotation}.
   */
  subscribeAnnotations(
    traceId: string,
    callback: (event: AnnotationEvent) => void,
  ): () => void {
    let set = this.annotationSubscribers.get(traceId);
    if (!set) {
      set = new Set();
      this.annotationSubscribers.set(traceId, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.annotationSubscribers.delete(traceId);
    };
  }

  emitAnnotation(
    traceId: string,
    op: AnnotationEventOp,
    annotation: Annotation,
  ): void {
    // A trace's summary carries its annotation counts, so watchers need to
    // know even when nobody is subscribed to this trace.
    this.emitChange({ type: "update", traceId });
    const set = this.annotationSubscribers.get(traceId);
    if (!set) return;
    const event: AnnotationEvent = { type: "annotation", op, annotation };
    for (const cb of set) {
      try {
        cb(event);
      } catch (err) {
        console.error("Annotation subscriber threw:", err);
      }
    }
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
    if (isRoot && stored.endTime === undefined) {
      await this.reopenTrace(span.traceId);
    }
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

  /**
   * Marks a trace that already ended as running again: its root span has just
   * been started anew (a failed run being retried), so the failure it recorded
   * is no longer its state.
   */
  private async reopenTrace(traceId: string): Promise<void> {
    const existing = await this.getTraceWithoutSpans(traceId);
    if (!existing || existing.status === "running") return;
    const { errorMessage: _failure, ...attributes } = existing.attributes ?? {};
    const reopened: Trace = {
      ...existing,
      endTime: undefined,
      status: "running",
      attributes,
    };
    await this.addOrUpdateTrace(reopened);
    this.emitStream(traceId, { type: "trace-update", trace: reopened });
    this.emitChange({ type: "update", traceId });
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

  protected emitStream(traceId: string, event: TraceStreamEvent): void {
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

  protected emitChange(event: TraceChangeEvent): void {
    for (const cb of this.watchers) {
      try {
        cb(event);
      } catch (err) {
        console.error("Trace watcher threw:", err);
      }
    }
  }
}
