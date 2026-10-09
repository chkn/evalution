// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The data model of offline evals: a prompt, a dataset, and a set of checks,
 * saved as data and run against the prompt's latest version or its
 * variations. See `specs/evals.md`.
 */

import type {
  ExecutionInput,
  PromptRef,
  RunResources,
  VariationConflict,
  VariationId,
  VersionId,
} from "../shared/types.ts";
import type { PromptID, TraceEvalRun } from "../trace/trace-types.ts";

/** One check, as an eval uses it. See `specs/evals.md` §A. */
export interface EvalCheck {
  /** Stable within the eval; results are keyed by it. */
  id: string;
  /** The check's URI: `<module>#<export>`, or a built-in's `evalution/checks#<name>`. */
  uri: string;
  /** Overrides the check's own label in this eval. */
  label?: string;
  /** Values for the check's schema-valued inputs, by name. */
  args: Record<string, ExecutionInput>;
  /**
   * For a check that returns a score: at or above this passes. Absent: the
   * score is reported on its own.
   */
  threshold?: number;
}

/**
 * One binding per prompt slot, keyed by slot name, in the shape the execute
 * panel persists. A binding may name a column (`dataset`), another slot
 * (`input`), a resource instance (`instance`), a typed-in value, or an
 * object mixing those.
 */
export interface EvalInputs {
  /** Function parameter name → binding. */
  functionInputs: Record<string, ExecutionInput>;
  /** Execute parameter name → binding. */
  executeInputs: Record<string, ExecutionInput>;
  /**
   * Resource instances every row's run declares, merged with the row's own
   * (`DatasetRow.resources`) — the row's win on a name both declare. See
   * `specs/resource-instances.md` §E.
   */
  resources?: RunResources;
}

/** A saved eval: data, stored by an `EvalProvider`. See `specs/evals.md` §A. */
export interface EvalDefinition {
  id: string;
  name: string;
  /** The prompt under test — its `globalId` when it has one, so moves and renames don't orphan it. */
  prompt: PromptID;
  /** The dataset whose rows are run. */
  dataset: { providerId: string; id: string };
  /** See {@link EvalInputs}. */
  inputs: EvalInputs;
  checks: EvalCheck[];
  /** Creation timestamp (ms). */
  createdAt: number;
  /** Timestamp (ms) of the last change. */
  updatedAt: number;
}

/** What `EvalProvider.createEval` takes. */
export type NewEvalDefinition = Omit<
  EvalDefinition,
  "id" | "createdAt" | "updatedAt"
>;

/** What `EvalProvider.updateEval` takes: any of the definition's fields. */
export type EvalDefinitionPatch = Partial<
  Omit<EvalDefinition, "id" | "createdAt" | "updatedAt">
>;

/**
 * Which prompt variant an arm runs. See `specs/evals.md` §C.
 *
 * - `head` — the working tree;
 * - `wip` — the unsaved edits, frozen when the run starts;
 * - `variation` — a named variation, rebased onto head when the run starts.
 */
export type EvalArmSpec =
  | { kind: "head" }
  | { kind: "wip"; variation: VariationId }
  | { kind: "variation"; variation: VariationId; label?: string };

/** One arm of a run, as it was set up when the run started. */
export interface EvalArm {
  /** Stable within the run; results are keyed by it. */
  id: string;
  /** How the run view labels it: "Working tree", "Unsaved edits", a variation's name. */
  label: string;
  /** What was asked for. */
  spec: EvalArmSpec;
  /** What every row of this arm runs. Absent when {@link error} is set. */
  ref?: PromptRef;
  /** The frozen, rebased variation the arm's rows run, when it runs one. */
  rebasedTo?: VariationId;
  /** Why the arm didn't run — a rebase conflict, say. */
  error?: string;
  /** The conflicts, when {@link error} is a rebase conflict. */
  conflicts?: VariationConflict[];
}

/** A run's lifecycle. */
export type EvalRunStatus = "running" | "done" | "cancelled" | "error";

/** How a run's check results break down. */
export interface EvalCounts {
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  /** Scores reported without a threshold, so neither pass nor fail. */
  scored: number;
}

/** What `EvalProvider.createRun` takes. */
export interface NewEvalRun {
  /** The eval as it was when the run started — runs keep meaning what they measured. */
  definition: EvalDefinition;
  arms: EvalArm[];
  /** The commit checked out at start, on a clean tree. */
  startVersion?: VersionId;
  /** Whether the working tree had uncommitted changes at start. */
  dirty: boolean;
  /** How many (arm, row) runs may be in flight at once. */
  concurrency: number;
  /** How many (arm, row) runs the run will make. */
  total: number;
}

/** A run of an eval. */
export interface EvalRun extends NewEvalRun {
  id: string;
  evalId: string;
  status: EvalRunStatus;
  /**
   * Whether a row ran against a different version than the run started on —
   * the working tree changed mid-run. See `specs/evals.md` §C.
   */
  drifted: boolean;
  /** Start timestamp (ms). */
  startedAt: number;
  /** End timestamp (ms), or `undefined` while running. */
  endedAt?: number;
}

/** A run as listed: without its definition, with its counts. */
export interface EvalRunSummary {
  id: string;
  evalId: string;
  status: EvalRunStatus;
  arms: Pick<EvalArm, "id" | "label" | "error">[];
  startVersion?: VersionId;
  dirty: boolean;
  drifted: boolean;
  startedAt: number;
  endedAt?: number;
  total: number;
  /** How many (arm, row) runs have finished. */
  done: number;
  counts: EvalCounts;
}

/** Compact eval entry for listings (sidebar / `GET /api/evals`). */
export interface EvalSummary {
  providerId: string;
  id: string;
  name: string;
  prompt: PromptID;
  dataset: { providerId: string; id: string };
  checkCount: number;
  updatedAt: number;
  /** The last run, when there's been one. */
  lastRun?: Pick<
    EvalRunSummary,
    "id" | "status" | "startedAt" | "counts" | "total" | "done"
  >;
}

/** How one (arm, row) run went. */
export type EvalRowStatus = "ok" | "error" | "skipped";

/** One (arm, row) run's result. See `specs/evals.md` §E. */
export interface EvalRowResult {
  runId: string;
  armId: string;
  rowId: string;
  /** Always 0 for now: the key is ready for running each row several times. */
  sample: number;
  /** The row's position in the dataset when the run started, from 0. */
  rowIndex: number;
  /** The row's cells as they were run — readable after the row is deleted. */
  rowCells: Record<string, ExecutionInput>;
  /**
   * The row's own resource instances as they were run, receipts stripped —
   * what `rowCells`' `instance` references named then, however the row has
   * changed since. See `specs/resource-instances.md` §C.
   */
  rowResources?: RunResources;
  traceProviderId?: string;
  traceId?: string;
  /** The version the row ran against, on a clean tree. */
  version?: VersionId;
  /** The variation the row applied. */
  variation?: VariationId;
  status: EvalRowStatus;
  /** Why the row errored or was skipped. */
  error?: string;
  /** Copied from the trace, so summaries needn't open it. */
  costUsd?: number;
  durationMs?: number;
  /** The trace didn't finish arriving before the checks ran. */
  traceIncomplete?: boolean;
}

/** How one check judged one (arm, row) run. See `specs/evals.md` §B.3. */
export type EvalCheckOutcome = "pass" | "fail" | "error" | "skipped" | "scored";

/** One check's result for one (arm, row) run. */
export interface EvalCheckResult {
  runId: string;
  armId: string;
  rowId: string;
  sample: number;
  checkId: string;
  outcome: EvalCheckOutcome;
  score?: number;
  message?: string;
  details?: unknown;
  durationMs?: number;
}

/** What `EvalProvider.listResults` returns. */
export interface EvalResults {
  rows: EvalRowResult[];
  checks: EvalCheckResult[];
}

/** A check result, with enough of its run to say where it came from — for the trace view. */
export interface TraceCheckResult extends EvalCheckResult {
  evalId: string;
  evalName: string;
  /** The check's label as the run's definition had it. */
  checkLabel: string;
  armLabel: string;
}

/** A trace an eval run produced, with the run — see `EvalProvider.listTraceRuns`. */
export interface EvalTraceRun extends Omit<TraceEvalRun, "providerId"> {
  traceProviderId: string;
  traceId: string;
}

/** The kind of change an {@link EvalChangeEvent} describes. */
export type EvalChangeType = "add" | "update" | "remove";

/** Describes a single change emitted by `EvalProvider.watch`. */
export interface EvalChangeEvent {
  type: EvalChangeType;
  evalId: string;
  /** Set when the change was to a run of the eval. */
  runId?: string;
}

/** Progress of a running eval, as the `eval-run` event carries it. See `specs/evals.md` §D.4. */
export interface EvalRunProgress {
  runId: string;
  evalId: string;
  providerId: string;
  done: number;
  total: number;
  counts: EvalCounts;
  status: EvalRunStatus;
}

/** Information about a registered eval provider. */
export interface EvalProviderInfo {
  id: string;
  displayName?: string;
}

/** Empty {@link EvalCounts}. */
export function emptyCounts(): EvalCounts {
  return { pass: 0, fail: 0, error: 0, skipped: 0, scored: 0 };
}
