// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Trace-level token/cost rollups, derived client-side from the spans the
 * trace view already holds. Kept out of the components so it can be
 * unit-tested without a browser (see `CLAUDE.md`).
 */

import type { Span } from "../../../shared/types";

/** Aggregate token/cost/model usage across a trace's spans, for the trace header. */
export interface UsageSummary {
  /** Sum of every span's `llm.promptTokens`; `undefined` if no span reports tokens. */
  promptTokens?: number;
  /** Sum of every span's `llm.completionTokens`; `undefined` if no span reports tokens. */
  completionTokens?: number;
  /** Sum of every span's `llm.cost`, broken down; `undefined` if no span reports a cost. */
  cost?: {
    prompt: number;
    completion: number;
  };
  /** The model name, if every span that reports one reports the same one. */
  model?: string;
}

/** Computes a {@link UsageSummary} across all of a trace's spans. */
export function summarizeUsage(spans: Span[]): UsageSummary {
  const hasTokens = spans.some(
    s =>
      s.llm?.promptTokens !== undefined ||
      s.llm?.completionTokens !== undefined,
  );
  const hasCost = spans.some(s => s.llm?.cost !== undefined);
  const models = new Set(
    spans.map(s => s.llm?.model).filter((m): m is string => !!m),
  );

  return {
    promptTokens: hasTokens
      ? spans.reduce((sum, s) => sum + (s.llm?.promptTokens ?? 0), 0)
      : undefined,
    completionTokens: hasTokens
      ? spans.reduce((sum, s) => sum + (s.llm?.completionTokens ?? 0), 0)
      : undefined,
    cost: hasCost
      ? {
          prompt: spans.reduce((sum, s) => sum + (s.llm?.cost?.prompt ?? 0), 0),
          completion: spans.reduce(
            (sum, s) => sum + (s.llm?.cost?.completion ?? 0),
            0,
          ),
        }
      : undefined,
    model: models.size === 1 ? [...models][0] : undefined,
  };
}

/** A cost breakdown ready to render: totals plus the implied $/1M-token prices. */
export interface CostBreakdown {
  prompt: number;
  completion: number;
  total: number;
  /** $/1M prompt tokens implied by `prompt` and the trace's prompt token count. */
  promptRate?: number;
  /** $/1M completion tokens implied by `completion` and the trace's completion token count. */
  completionRate?: number;
}

/** $/1M tokens implied by a dollar cost and the token count it covers. */
function impliedRate(
  cost: number,
  tokens: number | undefined,
): number | undefined {
  return tokens ? (cost / tokens) * 1_000_000 : undefined;
}

/**
 * Turns a {@link UsageSummary}'s `cost` into display-ready totals and implied
 * per-1M-token prices, or `undefined` when no span reported a cost.
 */
export function computeCostBreakdown(
  usage: UsageSummary,
): CostBreakdown | undefined {
  if (!usage.cost) return undefined;
  return {
    prompt: usage.cost.prompt,
    completion: usage.cost.completion,
    total: usage.cost.prompt + usage.cost.completion,
    promptRate: impliedRate(usage.cost.prompt, usage.promptTokens),
    completionRate: impliedRate(usage.cost.completion, usage.completionTokens),
  };
}
