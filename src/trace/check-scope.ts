// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Traces a check makes while it judges a run — an LLM judge's model call,
 * say — land in the trace it's judging, under a `CHECK` span of their own,
 * rather than as traces of their own that nothing groups with the run.
 *
 * The eval runner runs each check in a {@link CheckScope}; the
 * {@link CheckScopeTraceSink}, which every ingestor writes through, re-homes
 * whatever is recorded inside one. Being async-context-based, it works for
 * any ingestor and SDK without them knowing checks exist.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceSink } from "./trace-sink.ts";
import { CHECK_ATTRIBUTE, type Span } from "./trace-types.ts";

const scopes = new AsyncLocalStorage<CheckScope>();

/** What {@link CheckScope.end} records on the check's span. */
export interface CheckScopeResult {
  /** The check's outcome: `pass`, `fail`, `error`, … */
  outcome: string;
  message?: string;
}

/**
 * One check judging one run. Its span — kind `CHECK`, under the run's root —
 * is opened by the first span recorded {@link run | inside it}, so a check
 * that traces nothing adds nothing to the trace.
 */
export class CheckScope {
  /** The trace being judged. */
  readonly traceId: string;
  private readonly parentId: string;
  private readonly name: string;
  private readonly checkId: string;
  private opened?: Promise<{ span: Span; sink: TraceSink }>;

  constructor(options: {
    /** The trace being judged. */
    traceId: string;
    /** Its root span, which the check's span goes under. */
    parentId: string;
    /** The check's label, which names its span. */
    name: string;
    /** The check's id within its eval, stamped on every span it records. */
    checkId: string;
  }) {
    this.traceId = options.traceId;
    this.parentId = options.parentId;
    this.name = options.name;
    this.checkId = options.checkId;
  }

  /** The scope active in the current async context, if any. */
  static current(): CheckScope | undefined {
    return scopes.getStore();
  }

  /** Calls `fn` with this scope active for everything it does. */
  run<T>(fn: () => T): T {
    return scopes.run(this, fn);
  }

  /**
   * `span`, re-homed into the judged trace: under the check's span if it was
   * a root, and stamped as the check's. Opens the check's span on `sink`
   * the first time.
   */
  async rehome(span: Span, sink: TraceSink): Promise<Span> {
    const parentId =
      span.parentId ?? (await this.open(sink, span.startTime)).span.id;
    return {
      ...span,
      traceId: this.traceId,
      parentId,
      attributes: { ...span.attributes, [CHECK_ATTRIBUTE]: this.checkId },
    };
  }

  /** Ends the check's span, if anything opened it, with the check's result. */
  async end(result: CheckScopeResult): Promise<void> {
    if (!this.opened) return;
    const { span, sink } = await this.opened;
    await sink.recordSpanEnd({
      ...span,
      endTime: Date.now(),
      status: result.outcome === "error" ? "error" : "ok",
      ...(result.outcome === "error" &&
        result.message && { errorMessage: result.message }),
      attributes: {
        ...span.attributes,
        "evalution.check.outcome": result.outcome,
        ...(result.message && { "evalution.check.message": result.message }),
      },
    });
  }

  private open(
    sink: TraceSink,
    startTime: number,
  ): Promise<{ span: Span; sink: TraceSink }> {
    // Memoized as a promise: a check's calls may start concurrently, and
    // they all go under the one span.
    this.opened ??= (async () => {
      const span: Span = {
        id: crypto.randomUUID(),
        traceId: this.traceId,
        parentId: this.parentId,
        name: this.name,
        kind: "CHECK",
        startTime,
        attributes: { [CHECK_ATTRIBUTE]: this.checkId },
      };
      await sink.recordSpanStart(span);
      return { span, sink };
    })();
    return this.opened;
  }
}

/**
 * A {@link TraceSink} that passes spans on to its own sinks, re-homing those
 * recorded inside a {@link CheckScope} into the trace that scope judges.
 */
export class CheckScopeTraceSink implements TraceSink {
  private readonly sinks: TraceSink[] = [];

  /** Spans go on to each of these, re-homed or not. */
  private readonly downstream: TraceSink = {
    recordSpanStart: async span => {
      await Promise.all(this.sinks.map(s => s.recordSpanStart(span)));
      return span;
    },
    recordSpanEnd: async span => {
      await Promise.all(this.sinks.map(s => s.recordSpanEnd(span)));
      return span;
    },
    failTrace: async (traceId, message) => {
      await Promise.all(this.sinks.map(s => s.failTrace(traceId, message)));
    },
  };

  /** Add a downstream sink. May be called multiple times. */
  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  async recordSpanStart(span: Span): Promise<Span> {
    return this.downstream.recordSpanStart(await this.rehomed(span));
  }

  async recordSpanEnd(span: Span): Promise<Span> {
    return this.downstream.recordSpanEnd(await this.rehomed(span));
  }

  async failTrace(traceId: string, errorMessage: string): Promise<void> {
    // A check's own trace was never created — its root went under the
    // check's span — and failing the judged trace instead would be wrong:
    // the check's result already says it failed.
    if (CheckScope.current()) return;
    await this.downstream.failTrace(traceId, errorMessage);
  }

  private async rehomed(span: Span): Promise<Span> {
    const scope = CheckScope.current();
    return scope ? scope.rehome(span, this.downstream) : span;
  }
}
