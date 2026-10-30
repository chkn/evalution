// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TraceSinkEvent } from "./http-trace-sink.ts";
import { BaseTraceIngestor } from "./trace-ingestor.ts";

/**
 * {@link TraceIngestor} populated by the {@link TraceSinkEvent}s an app's
 * `HttpTraceSink` sends to this server. The events are already normalized
 * {@link TraceSink} calls, so this just replays them, in order, on its own
 * sinks.
 */
export class TraceEventIngestor extends BaseTraceIngestor {
  /** Records one batch of events, in order. */
  async ingest(events: TraceSinkEvent[]): Promise<void> {
    for (const event of events) {
      switch (event.type) {
        case "span-start":
          await this.recordSpanStart(event.span);
          break;
        case "span-end":
          await this.recordSpanEnd(event.span);
          break;
        case "trace-fail":
          await this.failTrace(event.traceId, event.errorMessage);
          break;
      }
    }
  }
}
