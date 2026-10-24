// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Span } from "./trace-types.ts";

/**
 * Merges a later snapshot of a span into an earlier one.
 *
 * OpenTelemetry reports each span twice — at `onStart` (creation-time
 * attributes only) and at `onEnd` (the full set) — and the two snapshots can
 * carry complementary data. This unions their `attributes` and `resource`,
 * and lets any *defined* field on `incoming` update `existing`, so nothing
 * recorded at start is lost when the span ends, and end-only fields (status,
 * timings, token usage, …) are filled in.
 *
 * An ended span is final: a snapshot of it after its end is a re-report of
 * what already happened (a durable workflow replaying a finished step from
 * its record, say), whose timings are the replay's, not the work's.
 */
export function mergeSpans(existing: Span, incoming: Span): Span {
  if (existing.endTime !== undefined) return existing;
  const merged = { ...existing } as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value;
  }
  const result = merged as unknown as Span;
  if (existing.attributes || incoming.attributes) {
    result.attributes = { ...existing.attributes, ...incoming.attributes };
  }
  if (existing.resource || incoming.resource) {
    result.resource = { ...existing.resource, ...incoming.resource };
  }
  return result;
}
