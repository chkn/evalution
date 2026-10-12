// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Trace-level token/cost rollups, derived client-side from the spans the
 * trace view already holds. Kept out of the components so it can be
 * unit-tested without a browser (see `CLAUDE.md`).
 */

import type { Span } from "../../../shared/types";
import { isCheckSpan } from "../../../trace/trace-types";

/** Aggregate token/cost/model usage across a trace's spans, for the trace header. */
export interface UsageSummary {
  /** Sum of every span's `llm.promptTokens`; `undefined` if no span reports tokens. */
  promptTokens?: number;
  /** Sum of every span's `llm.completionTokens`; `undefined` if no span reports tokens. */
  completionTokens?: number;
  /** Sum of every span's `llm.cacheReadTokens`; `undefined` if no span reports them. */
  cacheReadTokens?: number;
  /** Sum of every span's `llm.cacheWriteTokens`; `undefined` if no span reports them. */
  cacheWriteTokens?: number;
  /**
   * Sum of every span's `llm.cost`, broken down; `undefined` if no span
   * reports a cost. `cacheRead`/`cacheWrite` are parts of `prompt`, present
   * only if some span breaks them out.
   */
  cost?: {
    prompt: number;
    completion: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** The model name, if every span that reports one reports the same one. */
  model?: string;
}

/**
 * Computes a {@link UsageSummary} across a trace's spans — the run's own: what
 * an eval check spent judging it isn't the run's.
 */
export function summarizeUsage(allSpans: Span[]): UsageSummary {
  const spans = allSpans.filter(s => !isCheckSpan(s));
  /** Sums `pick` over the spans, or `undefined` if no span reports it. */
  const sumOf = (pick: (s: Span) => number | undefined) => {
    const values = spans.map(pick).filter(v => v !== undefined);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
  };
  const hasTokens = spans.some(
    s =>
      s.llm?.promptTokens !== undefined ||
      s.llm?.completionTokens !== undefined,
  );
  const hasCost = spans.some(s => s.llm?.cost !== undefined);
  const cacheReadTokens = sumOf(s => s.llm?.cacheReadTokens);
  const cacheWriteTokens = sumOf(s => s.llm?.cacheWriteTokens);
  const cacheReadCost = sumOf(s => s.llm?.cost?.cacheRead);
  const cacheWriteCost = sumOf(s => s.llm?.cost?.cacheWrite);
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
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
    cost: hasCost
      ? {
          prompt: spans.reduce((sum, s) => sum + (s.llm?.cost?.prompt ?? 0), 0),
          completion: spans.reduce(
            (sum, s) => sum + (s.llm?.cost?.completion ?? 0),
            0,
          ),
          ...(cacheReadCost !== undefined && { cacheRead: cacheReadCost }),
          ...(cacheWriteCost !== undefined && { cacheWrite: cacheWriteCost }),
        }
      : undefined,
    model: models.size === 1 ? [...models][0] : undefined,
  };
}

/**
 * A cost breakdown ready to render: totals plus the implied $/1M-token prices.
 * `prompt`, `cacheRead`, `cacheWrite` and `completion` add up to `total`.
 */
export interface CostBreakdown {
  /** Prompt tokens' cost, less what is broken out as `cacheRead`/`cacheWrite`. */
  prompt: number;
  completion: number;
  /** Cache reads' cost; present only if the trace read any cached tokens. */
  cacheRead?: number;
  /** Cache writes' cost; present only if the trace wrote any cached tokens. */
  cacheWrite?: number;
  total: number;
  /** $/1M prompt tokens implied by `prompt` and the prompt tokens it covers. */
  promptRate?: number;
  /** $/1M cache-read tokens implied by `cacheRead`. */
  cacheReadRate?: number;
  /** $/1M cache-write tokens implied by `cacheWrite`. */
  cacheWriteRate?: number;
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

/** A cache cost paired with the tokens it covers, if it covers any. */
function brokenOut(
  cost: number | undefined,
  tokens: number | undefined,
): { cost: number; tokens: number } | undefined {
  return cost !== undefined && tokens ? { cost, tokens } : undefined;
}

/**
 * Turns a {@link UsageSummary}'s `cost` into display-ready totals and implied
 * per-1M-token prices, or `undefined` when no span reported a cost.
 */
export function computeCostBreakdown(
  usage: UsageSummary,
): CostBreakdown | undefined {
  const { cost } = usage;
  if (!cost) return undefined;
  // Break a cache cost out of the prompt's only if it covers some tokens, so
  // an SDK that reports zero cache tokens on every call shows no empty rows.
  const cacheRead = brokenOut(cost.cacheRead, usage.cacheReadTokens);
  const cacheWrite = brokenOut(cost.cacheWrite, usage.cacheWriteTokens);
  const prompt = cost.prompt - (cacheRead?.cost ?? 0) - (cacheWrite?.cost ?? 0);
  const uncachedTokens =
    usage.promptTokens === undefined
      ? undefined
      : usage.promptTokens -
        (cacheRead?.tokens ?? 0) -
        (cacheWrite?.tokens ?? 0);
  return {
    prompt,
    completion: cost.completion,
    ...(cacheRead && {
      cacheRead: cacheRead.cost,
      cacheReadRate: impliedRate(cacheRead.cost, cacheRead.tokens),
    }),
    ...(cacheWrite && {
      cacheWrite: cacheWrite.cost,
      cacheWriteRate: impliedRate(cacheWrite.cost, cacheWrite.tokens),
    }),
    total: cost.prompt + cost.completion,
    promptRate: impliedRate(prompt, uncachedTokens),
    completionRate: impliedRate(cost.completion, usage.completionTokens),
  };
}
