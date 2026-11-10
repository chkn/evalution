// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import type { TraceSink } from "./trace-sink.ts";
import type { Span } from "./trace-types.ts";

/**
 * Where an evalution server accepts {@link TraceSinkEvent}s, relative to its
 * base URL.
 */
export const TRACE_EVENTS_PATH = "/api/traces";

/** One {@link TraceSink} call, as {@link HttpTraceSink} sends it. */
export type TraceSinkEvent =
  | { type: "span-start"; span: Span }
  | { type: "span-end"; span: Span }
  | { type: "trace-fail"; traceId: string; errorMessage: string };

/** The body of a `POST` to {@link TRACE_EVENTS_PATH}. */
export interface TraceEventsRequest {
  /** The events to record, in the order they happened. */
  events: TraceSinkEvent[];
}

/** Options for {@link HttpTraceSink}. */
export interface HttpTraceSinkOptions {
  /**
   * The evalution server's base URL, e.g. `http://localhost:3000`. Events are
   * posted to {@link TRACE_EVENTS_PATH} under it.
   */
  endpoint: string;
  /** The `fetch` to send with. Defaults to the global one. */
  fetch?: typeof fetch;
}

/**
 * A {@link TraceSink} that sends what it's given to an evalution server,
 * which records it through its own trace providers — so an app's traces show
 * up in the playground without the app writing to a trace store itself.
 *
 * Calls return as soon as the event is queued, never waiting on the network,
 * so tracing doesn't slow the app down. Queued events go out in order, batched
 * into one request at a time, so a span's end never overtakes its start. A
 * request that fails is logged and its events dropped: tracing never breaks
 * the app. Await {@link flush} before a short-lived process exits to be sure
 * everything was sent.
 */
export class HttpTraceSink implements TraceSink {
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private queue: TraceSinkEvent[] = [];
  private sending?: Promise<void>;
  /** Whether the last request failed, so a down server is reported once. */
  private failing = false;

  constructor(options: HttpTraceSinkOptions) {
    this.url = options.endpoint.replace(/\/+$/, "") + TRACE_EVENTS_PATH;
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  async recordSpanStart(span: Span): Promise<Span> {
    this.enqueue({ type: "span-start", span });
    return span;
  }

  async recordSpanEnd(span: Span): Promise<Span> {
    this.enqueue({ type: "span-end", span });
    return span;
  }

  async failTrace(traceId: string, errorMessage: string): Promise<void> {
    this.enqueue({ type: "trace-fail", traceId, errorMessage });
  }

  /** Resolves once every event recorded so far has been sent (or dropped). */
  async flush(): Promise<void> {
    return this.sending ?? Promise.resolve();
  }

  private enqueue(event: TraceSinkEvent): void {
    this.queue.push(event);
    this.sending ??= this.drain();
  }

  private async drain(): Promise<void> {
    // Wait a macrotask, so events recorded in quick succession — even one
    // awaited call after another — share the first batch.
    await new Promise(resolve => setTimeout(resolve));
    while (this.queue.length > 0) {
      const events = this.queue;
      this.queue = [];
      await this.send(events);
    }
    this.sending = undefined;
  }

  private async send(events: TraceSinkEvent[]): Promise<void> {
    try {
      const body: TraceEventsRequest = { events };
      const res = await this.fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
      }
      this.failing = false;
    } catch (err) {
      if (!this.failing) {
        console.warn(
          `[evalution] Couldn't send traces to ${this.url}:`,
          err instanceof Error ? err.message : err,
        );
      }
      this.failing = true;
    }
  }
}
