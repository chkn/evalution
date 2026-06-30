// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Span } from "./trace-types.ts";

/**
 * Merges a later snapshot of a span into an earlier one.
 *
 * OpenTelemetry reports each span twice — at `onStart` (creation-time
 * attributes only) and at `onEnd` (the full set) — and the two snapshots can
 * carry complementary data. This unions their `attributes` and lets any
 * *defined* field on `incoming` update `existing`, so nothing recorded at start
 * is lost when the span ends, and end-only fields (status, timings, token
 * usage, …) are filled in.
 */
export function mergeSpans(existing: Span, incoming: Span): Span {
  const merged = { ...existing } as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value;
  }
  const result = merged as unknown as Span;
  if (existing.attributes || incoming.attributes) {
    result.attributes = { ...existing.attributes, ...incoming.attributes };
  }
  return result;
}
