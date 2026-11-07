// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  type EvalCounts,
  emptyCounts,
  type TraceCheckResult,
} from "../../../eval/eval-types";
import type { TraceEvalRun } from "../../../shared/types";

/** A check result as `getTraceCheckResults` returns it. */
export type ProvidedCheckResult = TraceCheckResult & { providerId: string };

/** Opens an eval run recorded on the eval provider `providerId`. */
export type OpenEvalRun = (
  providerId: string,
  run: { id: string; startedAt: number },
  evalName: string,
) => void;

/** A (run, arm) that a trace came from or was judged by, with its check results. */
export interface TraceCheckRun {
  /** The eval provider the run is recorded on. */
  providerId: string;
  runId: string;
  armId: string;
  evalName: string;
  armLabel: string;
  startedAt: number;
  results: ProvidedCheckResult[];
}

/**
 * Groups a trace's check results by (run, arm), in order of first appearance,
 * after `evalRun` — the run the trace came from, which has a group of its own
 * even before it has recorded any checks.
 */
export function groupCheckRuns(
  results: ProvidedCheckResult[],
  evalRun?: TraceEvalRun,
): TraceCheckRun[] {
  const runs = new Map<string, TraceCheckRun>();
  const groupOf = (run: Omit<TraceCheckRun, "results">) => {
    const key = JSON.stringify([run.providerId, run.runId, run.armId]);
    const found = runs.get(key);
    if (found) return found;
    const { providerId, runId, armId, evalName, armLabel, startedAt } = run;
    const group: TraceCheckRun = {
      providerId,
      runId,
      armId,
      evalName,
      armLabel,
      startedAt,
      results: [],
    };
    runs.set(key, group);
    return group;
  };
  if (evalRun) groupOf(evalRun);
  for (const result of results) groupOf(result).results.push(result);
  return [...runs.values()];
}

/** How a run's check results break down by outcome. */
export function countOutcomes(results: ProvidedCheckResult[]): EvalCounts {
  const counts = emptyCounts();
  for (const r of results) counts[r.outcome] += 1;
  return counts;
}
