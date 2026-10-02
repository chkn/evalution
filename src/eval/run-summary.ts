// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A run's results summarized per arm — pass rates, mean scores, cost, and
 * latency — for the run view and the MCP server alike. Pure.
 */

import {
  type EvalCounts,
  type EvalResults,
  emptyCounts,
} from "./eval-types.ts";

/** One check's line in an arm's summary. */
export interface CheckSummary {
  checkId: string;
  /** Passes over pass + fail; `undefined` when nothing passed or failed. */
  passRate?: number;
  /** The mean of the scores reported, when any were. */
  meanScore?: number;
  counts: EvalCounts;
}

/** The summary strip for one arm. */
export interface ArmSummary {
  armId: string;
  checks: CheckSummary[];
  /** Rows that errored or were skipped before any check ran. */
  rowErrors: number;
  /** Total cost, when any row reported one. */
  totalCost?: number;
  p50Duration?: number;
  p95Duration?: number;
}

/** The `p`th percentile (0–1) of `values`, nearest-rank; `undefined` when empty. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

/** Passes over pass + fail, or `undefined` when neither happened. */
export function passRate(counts: EvalCounts): number | undefined {
  const judged = counts.pass + counts.fail;
  return judged === 0 ? undefined : counts.pass / judged;
}

/** One arm's summary strip, for the checks in `checkIds` order. */
export function summarizeArm(
  results: EvalResults,
  armId: string,
  checkIds: readonly string[],
): ArmSummary {
  const rows = results.rows.filter(r => r.armId === armId);
  const checks = results.checks.filter(c => c.armId === armId);
  const costs = rows.flatMap(r => (r.costUsd === undefined ? [] : [r.costUsd]));
  const durations = rows.flatMap(r =>
    r.durationMs === undefined ? [] : [r.durationMs],
  );
  return {
    armId,
    checks: checkIds.map(checkId => {
      const counts = emptyCounts();
      const scores: number[] = [];
      for (const c of checks) {
        if (c.checkId !== checkId) continue;
        counts[c.outcome]++;
        if (c.score !== undefined) scores.push(c.score);
      }
      return {
        checkId,
        counts,
        ...(passRate(counts) !== undefined && { passRate: passRate(counts) }),
        ...(scores.length > 0 && {
          meanScore: scores.reduce((a, b) => a + b, 0) / scores.length,
        }),
      };
    }),
    rowErrors: rows.filter(r => r.status !== "ok").length,
    ...(costs.length > 0 && { totalCost: costs.reduce((a, b) => a + b, 0) }),
    ...(durations.length > 0 && {
      p50Duration: percentile(durations, 0.5),
      p95Duration: percentile(durations, 0.95),
    }),
  };
}
