// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
//
// This file is dual-licensed. As shipped inside the AGPL-licensed `evalution`
// core it is covered by AGPL-3.0-only; as bundled into an MIT-licensed SDK
// adapter package it is covered by MIT. Keep this file self-contained — it
// must import nothing from the rest of the core (only sibling dual-licensed
// `src/trace/` modules). See LICENSING.md.

import type { TraceSink } from "./trace-sink.ts";
import type { Span } from "./trace-types.ts";

/**
 * A source of trace data. Translates some upstream signal (OTel spans, native
 * AI SDK telemetry, an external collector) into normalized {@link Span}s and
 * feeds the {@link TraceSink}(s) it is connected to.
 */
export interface TraceIngestor {
  /**
   * Add a sink. May be called multiple times; the ingestor writes to every
   * added sink.
   */
  addSink(sink: TraceSink): void;

  /**
   * Remove a previously-added sink. Returns `true` if the given sink was found
   * and removed, otherwise `false`.
   */
  removeSink(sink: TraceSink): boolean;

  /**
   * Optional: returns true if `other` is made redundant by this ingestor and
   * should be excluded from the collected set. The decision may depend on
   * this ingestor's own configuration. Used by the server to consolidate
   * overlapping ingestors — e.g. `OTelTraceIngestor` reports any other
   * `OTelTraceIngestor` redundant because OTel is a single process-global
   * pipeline.
   */
  isRedundant?(other: TraceIngestor): boolean;
}

/**
 * Base class that holds the added sinks and fans each normalized record out
 * to all of them. Concrete ingestors translate their source into
 * {@link Span}/{@link Trace} records and call these protected helpers.
 */
export abstract class BaseTraceIngestor implements TraceIngestor {
  protected sinks: TraceSink[] = [];

  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  removeSink(sink: TraceSink): boolean {
    const prevSinks = this.sinks;
    const newSinks = prevSinks.filter(s => s !== sink);
    this.sinks = newSinks;
    return prevSinks.length > newSinks.length;
  }

  protected async recordSpanStart(span: Span): Promise<void> {
    await Promise.all(this.sinks.map(s => s.recordSpanStart(span)));
  }

  protected async recordSpanEnd(span: Span): Promise<void> {
    await Promise.all(this.sinks.map(s => s.recordSpanEnd(span)));
  }

  protected async failTrace(traceId: string, msg: string): Promise<void> {
    await Promise.all(this.sinks.map(s => s.failTrace(traceId, msg)));
  }
}
