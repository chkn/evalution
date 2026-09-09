// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { llmAndPrompt, readKind } from "./otel-attributes.ts";
import type {
  NormalizedOtlpEvent,
  NormalizedOtlpSpan,
} from "./otlp/normalize.ts";
import { BaseTraceIngestor } from "./trace-ingestor.ts";
import type { Span } from "./trace-types.ts";

function eventErrorMessage(
  events: NormalizedOtlpEvent[] | undefined,
): string | undefined {
  for (const event of events ?? []) {
    const message =
      event.attributes["exception.message"] ?? event.attributes.message;
    if (typeof message === "string" && message) return message;
  }
  return undefined;
}

/**
 * Orders a batch so a span's parent (when present in the same batch) is
 * always ingested before it — a cheap approximation of a topological sort by
 * BFS depth, not a strict one. `BaseTraceProvider` already tolerates
 * out-of-order arrival (provisional trace creation + `mergeSpans` on
 * re-delivery), so this is purely an optimisation, not a correctness
 * requirement.
 */
function sortParentsFirst(spans: NormalizedOtlpSpan[]): NormalizedOtlpSpan[] {
  const bySpanId = new Map(spans.map(s => [s.spanId, s]));
  const depths = new Map<string, number>();

  function depthOf(span: NormalizedOtlpSpan, path: Set<string>): number {
    const cached = depths.get(span.spanId);
    if (cached !== undefined) return cached;
    const parent = span.parentSpanId
      ? bySpanId.get(span.parentSpanId)
      : undefined;
    // Guard against a (malformed) cycle within the batch rather than
    // recursing forever.
    const depth =
      !parent || path.has(span.spanId)
        ? 0
        : depthOf(parent, new Set(path).add(span.spanId)) + 1;
    depths.set(span.spanId, depth);
    return depth;
  }

  return [...spans].sort(
    (a, b) =>
      depthOf(a, new Set()) - depthOf(b, new Set()) ||
      a.startTimeMs - b.startTimeMs,
  );
}

function toSpan(s: NormalizedOtlpSpan): Span {
  return {
    id: s.spanId,
    traceId: s.traceId,
    parentId: s.parentSpanId,
    name: s.name,
    kind: readKind(s.attributes),
    startTime: s.startTimeMs,
    ...(s.endTimeMs !== undefined && { endTime: s.endTimeMs }),
    ...(s.statusCode !== "unset" && { status: s.statusCode }),
    ...(s.statusCode === "error" && {
      errorMessage: s.statusMessage || eventErrorMessage(s.events),
    }),
    attributes: s.attributes,
    ...llmAndPrompt(s.attributes),
  };
}

/**
 * {@link TraceIngestor} populated by spans received over OTLP (protobuf or
 * JSON) from an external app or collector — see `specs/trace-workshopping.md`
 * §A. Unlike {@link OTelTraceIngestor}, OTLP arrives as a batch of already
 * -finished (or explicitly in-flight) spans with no separate start/end
 * lifecycle of its own.
 *
 * `BaseTraceProvider.recordSpanEnd` only *finalizes* a trace that
 * `recordSpanStart` already created (root detection happens there), so
 * {@link ingest} always calls `recordSpanStart` first — for an
 * already-ended span this immediately followed by `recordSpanEnd` — mirroring
 * the start-then-end pair {@link OTelTraceIngestor} fires for every real OTel
 * span. A span OTLP exported with no end time gets only the start.
 *
 * Storage-agnostic like every ingestor: works against `MemoryTraceProvider`
 * in tests and any other `TraceSink` in production with no code change.
 */
export class OtlpTraceIngestor extends BaseTraceIngestor {
  /** Ingests one OTLP export batch, already normalized by `./otlp/normalize.ts`. */
  async ingest(spans: NormalizedOtlpSpan[]): Promise<void> {
    for (const normalized of sortParentsFirst(spans)) {
      const span = toSpan(normalized);
      await this.recordSpanStart(span);
      if (span.endTime !== undefined) {
        await this.recordSpanEnd(span);
      }
    }
  }
}
