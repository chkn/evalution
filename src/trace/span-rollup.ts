// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Trace-summary rollups computed directly from a trace's spans — what
 * `MemoryTraceProvider.getAllTraces` uses, since it already holds every
 * trace's spans in memory. `TursoTraceProvider` computes the same rollups
 * with SQL aggregates instead of loading spans, for the same reason
 * `spanCount` is a SQL `count(*)` there rather than `spans.length`: avoiding
 * an N-row fetch per trace just to summarize it. Keep the two in sync.
 */

import type { Span } from "./trace-types.ts";

/** Token/cost/model rollup across a trace's spans, as carried by `TraceSummary`. */
export interface SpanRollup {
  totalTokens?: number;
  cost?: number;
  model?: string;
}

/**
 * One span's token count: `llm.totalTokens` if set, else
 * `promptTokens + completionTokens` (treating a missing one of those as 0) —
 * the same fallback `SpanDetails` uses to show a span's own token count.
 * `undefined` when the span reports no token usage at all, so it doesn't
 * pull a trace with genuinely no LLM spans down to a false "0 tokens".
 */
function spanTokens(span: Span): number | undefined {
  const llm = span.llm;
  if (!llm) return undefined;
  if (
    llm.totalTokens === undefined &&
    llm.promptTokens === undefined &&
    llm.completionTokens === undefined
  ) {
    return undefined;
  }
  return (
    llm.totalTokens ?? (llm.promptTokens ?? 0) + (llm.completionTokens ?? 0)
  );
}

/** Computes a {@link SpanRollup} across a trace's spans. */
export function rollupSpans(spans: Span[]): SpanRollup {
  const tokenContributions = spans
    .map(spanTokens)
    .filter((t): t is number => t !== undefined);
  const totalTokens =
    tokenContributions.length > 0
      ? tokenContributions.reduce((sum, t) => sum + t, 0)
      : undefined;

  const costContributions = spans
    .map(s => s.llm?.cost)
    .filter((c): c is { prompt: number; completion: number } => c !== undefined)
    .map(c => c.prompt + c.completion);
  const cost =
    costContributions.length > 0
      ? costContributions.reduce((sum, c) => sum + c, 0)
      : undefined;

  const models = new Set(
    spans.map(s => s.llm?.model).filter((m): m is string => !!m),
  );
  const model = models.size === 1 ? [...models][0] : undefined;

  return { totalTokens, cost, model };
}
