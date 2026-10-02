// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  EvalChangeEvent,
  EvalCheckResult,
  EvalDefinition,
  EvalDefinitionPatch,
  EvalResults,
  EvalRowResult,
  EvalRun,
  EvalRunStatus,
  EvalRunSummary,
  EvalSummary,
  NewEvalDefinition,
  NewEvalRun,
  TraceCheckResult,
} from "./eval-types.ts";

/** Thrown by an {@link EvalProvider} when the eval or run named doesn't exist. */
export class EvalNotFoundError extends Error {
  override name = "EvalNotFoundError";
}

/**
 * A store of evals, their runs, and their results. Parallel to
 * `DatasetProvider`: evals are data, not code, kept out of git. See
 * `specs/evals.md` §E.
 */
export interface EvalProvider {
  /** Uniquely identifies this instance. */
  readonly id: string;

  /** Human-readable name. */
  readonly displayName?: string;

  /** Every eval, most recently updated first, each with its last run. */
  listEvals(): Promise<Omit<EvalSummary, "providerId">[]>;

  /** An eval, or `undefined` if it doesn't exist. */
  getEval(id: string): Promise<EvalDefinition | undefined>;

  /** Saves a new eval, minting its id. */
  createEval(input: NewEvalDefinition): Promise<EvalDefinition>;

  /** Changes an eval. Rejects with {@link EvalNotFoundError} if it doesn't exist. */
  updateEval(id: string, patch: EvalDefinitionPatch): Promise<EvalDefinition>;

  /** Deletes an eval with its runs and results. A no-op if it doesn't exist. */
  deleteEval(id: string): Promise<void>;

  /** Records the start of a run of `evalId`. */
  createRun(evalId: string, run: NewEvalRun): Promise<EvalRun>;

  /**
   * Records a run's end. `drifted` is set when a row ran against a different
   * version than the run started on.
   */
  finishRun(
    runId: string,
    status: EvalRunStatus,
    options?: { drifted?: boolean },
  ): Promise<void>;

  /**
   * Marks every run still `running` as `error`, returning how many. The
   * server calls it once at startup, before its runner starts any: a run
   * `running` then was cut off when the server last stopped, and would
   * otherwise show as running forever.
   */
  interruptRuns(): Promise<number>;

  /** An eval's runs, newest first. */
  listRuns(evalId: string): Promise<EvalRunSummary[]>;

  /** A run, or `undefined` if it doesn't exist. */
  getRun(runId: string): Promise<EvalRun | undefined>;

  /**
   * Deletes a run with its results. A no-op if it doesn't exist. The caller
   * makes sure the run isn't still in flight.
   */
  deleteRun(runId: string): Promise<void>;

  /** Records one (arm, row) run's result. */
  recordRowResult(result: EvalRowResult): Promise<void>;

  /** Records check results. */
  recordCheckResults(results: EvalCheckResult[]): Promise<void>;

  /** A run's results. */
  listResults(runId: string): Promise<EvalResults>;

  /** Check results for one trace, so the trace view can show them. */
  resultsForTrace(
    traceProviderId: string,
    traceId: string,
  ): Promise<TraceCheckResult[]>;

  /**
   * Registers a callback invoked whenever an eval or one of its runs is
   * added, changed, or removed. Optional.
   *
   * @returns A no-argument function that unregisters the watcher.
   */
  watch?(callback: (event: EvalChangeEvent) => void): () => void;
}
