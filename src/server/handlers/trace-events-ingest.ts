// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TraceSinkEvent } from "@evalution/sdk";
import type { TraceEventIngestor } from "../../trace/trace-event-ingestor.ts";

/** What {@link handleTraceEvents} answers: an HTTP status and a JSON body. */
export interface TraceEventsIngestResult {
  status: number;
  body: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSpanLike(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.traceId === "string" &&
    typeof value.startTime === "number"
  );
}

/** Whether `value` is a {@link TraceSinkEvent} the ingestor can replay. */
function isTraceSinkEvent(value: unknown): value is TraceSinkEvent {
  if (!isObject(value)) return false;
  switch (value.type) {
    case "span-start":
    case "span-end":
      return isSpanLike(value.span);
    case "trace-fail":
      return (
        typeof value.traceId === "string" &&
        typeof value.errorMessage === "string"
      );
    default:
      return false;
  }
}

/**
 * Host-neutral handler for a batch of trace events an app's `HttpTraceSink`
 * sends (`POST /api/traces`). Takes the request body as text and
 * returns plain `{status, body}`, like `handleOtlpTraces`, so it stays usable
 * from Hono, a Worker, or a test.
 */
export async function handleTraceEvents(
  body: string,
  ingestor: TraceEventIngestor | undefined,
): Promise<TraceEventsIngestResult> {
  let events: unknown;
  try {
    events = JSON.parse(body)?.events;
  } catch (err: any) {
    return {
      status: 400,
      body: { error: `Malformed JSON: ${err?.message ?? err}` },
    };
  }
  if (!Array.isArray(events)) {
    return { status: 400, body: { error: "Expected an `events` array" } };
  }
  const invalid = events.findIndex(e => !isTraceSinkEvent(e));
  if (invalid >= 0) {
    return { status: 400, body: { error: `Malformed event at ${invalid}` } };
  }
  if (!ingestor) {
    return {
      status: 404,
      body: { error: "No trace ingestor available for this request" },
    };
  }

  await ingestor.ingest(events);
  return { status: 200, body: {} };
}
