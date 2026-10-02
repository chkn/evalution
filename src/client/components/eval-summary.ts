// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What the run view shows about a run, computed from its results: a summary
 * per arm, the grid's cells, and which rows changed between two runs. Pure.
 * See `specs/evals.md` §F.
 */

import type {
  EvalCheckOutcome,
  EvalCheckResult,
  EvalResults,
  EvalRowResult,
} from "../../eval/eval-types";
import { formatTimestampCompact } from "./trace/format.ts";

export {
  type ArmSummary,
  type CheckSummary,
  passRate,
  percentile,
  summarizeArm,
} from "../../eval/run-summary";

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

/** What to ask before deleting the run started at `startedAt`. */
export function deleteRunQuestion(startedAt: number, running: boolean): string {
  const what = `the run from ${formatTimestampCompact(startedAt)}`;
  return running
    ? `Cancel and delete ${what}, with its results?`
    : `Delete ${what} and its results?`;
}
