// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What the run view shows about a run, computed from its results: a summary
 * per arm, the grid's cells, and which rows changed between two runs. Pure.
 * See `specs/evals.md` §F.
 */

import {
  type EvalCheckOutcome,
  type EvalCheckResult,
  type EvalCounts,
  type EvalResults,
  type EvalRowResult,
  emptyCounts,
} from "../../eval/eval-types";

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

/** Key of one grid cell: `${armId}:${rowId}:${checkId}`. */
export function cellKey(armId: string, rowId: string, checkId: string): string {
  return `${armId}:${rowId}:${checkId}`;
}

/** Every check result, by {@link cellKey}. */
export function indexChecks(
  checks: readonly EvalCheckResult[],
): Map<string, EvalCheckResult> {
  return new Map(checks.map(c => [cellKey(c.armId, c.rowId, c.checkId), c]));
}

/** The grid's rows: one per dataset row, in the order the run saw them. */
export interface GridRow {
  rowId: string;
  rowIndex: number;
  /** Each arm's result for this row, by arm id. */
  arms: Map<string, EvalRowResult>;
}

/** The run's results as grid rows, by row index. */
export function gridRows(results: EvalResults): GridRow[] {
  const byRow = new Map<string, GridRow>();
  for (const r of results.rows) {
    let row = byRow.get(r.rowId);
    if (!row) {
      row = { rowId: r.rowId, rowIndex: r.rowIndex, arms: new Map() };
      byRow.set(r.rowId, row);
    }
    row.arms.set(r.armId, r);
  }
  return [...byRow.values()].sort((a, b) => a.rowIndex - b.rowIndex);
}

/** How one cell's outcome changed from the other run to this one. */
export interface OutcomeChange {
  rowId: string;
  armId: string;
  checkId: string;
  before?: EvalCheckOutcome;
  after?: EvalCheckOutcome;
  /** pass → fail (or error): the change to look at first. */
  regressed: boolean;
}

const GOOD = new Set<EvalCheckOutcome | undefined>(["pass"]);

/**
 * The cells whose outcome differs between `other` (before) and `current`
 * (after), for arms with the same label in both — regressions first. Rows
 * are matched by id, so a row deleted since has no counterpart.
 */
export function compareRuns(
  current: { results: EvalResults; arms: { id: string; label: string }[] },
  other: { results: EvalResults; arms: { id: string; label: string }[] },
): OutcomeChange[] {
  const otherArmByLabel = new Map(other.arms.map(a => [a.label, a.id]));
  const before = indexChecks(other.results.checks);
  const changes: OutcomeChange[] = [];
  for (const c of current.results.checks) {
    const label = current.arms.find(a => a.id === c.armId)?.label;
    const otherArm = label && otherArmByLabel.get(label);
    if (!otherArm) continue;
    const prev = before.get(cellKey(otherArm, c.rowId, c.checkId))?.outcome;
    if (prev === undefined || prev === c.outcome) continue;
    changes.push({
      rowId: c.rowId,
      armId: c.armId,
      checkId: c.checkId,
      before: prev,
      after: c.outcome,
      regressed: GOOD.has(prev) && !GOOD.has(c.outcome),
    });
  }
  return changes.sort((a, b) => Number(b.regressed) - Number(a.regressed));
}

/** "83%", or "—" when there's nothing to rate. */
export function formatRate(rate: number | undefined): string {
  return rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
}
