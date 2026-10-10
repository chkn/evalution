// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Drizzle sqlite-core schema backing {@link TursoEvalProvider}. See
 * `specs/evals.md` §E. One database holds every eval: results are the bulk,
 * they're queried across evals by trace id, and an eval's definition is a
 * few hundred bytes. fs-free by construction, like its siblings.
 */

import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/** One saved eval. JSON columns are text: small, one row per eval. */
export const evals = sqliteTable("evals", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** JSON `PromptID`. */
  prompt: text("prompt").notNull(),
  datasetProviderId: text("dataset_provider_id").notNull(),
  datasetId: text("dataset_id").notNull(),
  /** JSON `EvalInputs`. */
  inputs: text("inputs").notNull(),
  /** JSON `EvalCheck[]`. */
  checks: text("checks").notNull(),
  createdAt: real("created_at").notNull(),
  updatedAt: real("updated_at").notNull(),
});

/** One run of an eval. */
export const evalRuns = sqliteTable(
  "eval_runs",
  {
    id: text("id").primaryKey(),
    evalId: text("eval_id")
      .notNull()
      .references(() => evals.id, { onDelete: "cascade" }),
    /** JSON `EvalDefinition`: the eval as it was when the run started. */
    definition: text("definition").notNull(),
    /** JSON `EvalArm[]`. */
    arms: text("arms").notNull(),
    startVersion: text("start_version"),
    dirty: integer("dirty").notNull().default(0),
    status: text("status").notNull(),
    drifted: integer("drifted").notNull().default(0),
    concurrency: integer("concurrency").notNull(),
    /** How many (arm, row) runs the run makes. */
    total: integer("total").notNull(),
    startedAt: real("started_at").notNull(),
    endedAt: real("ended_at"),
  },
  t => [index("idx_eval_runs_eval").on(t.evalId, t.startedAt)],
);

/** One (arm, row, sample) run's result. */
export const evalRowResults = sqliteTable(
  "eval_row_results",
  {
    runId: text("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    armId: text("arm_id").notNull(),
    rowId: text("row_id").notNull(),
    /** Always 0 for now — in the key so running rows several times needs no migration. */
    sample: integer("sample").notNull().default(0),
    rowIndex: integer("row_index").notNull(),
    /** JSON: the row's cells as run. */
    rowCells: text("row_cells").notNull(),
    /** JSON: the row's own resource instances as run, if it declared any. */
    rowResources: text("row_resources"),
    traceProviderId: text("trace_provider_id"),
    traceId: text("trace_id"),
    version: text("version"),
    variation: text("variation"),
    status: text("status").notNull(),
    error: text("error"),
    costUsd: real("cost_usd"),
    durationMs: real("duration_ms"),
    traceIncomplete: integer("trace_incomplete").notNull().default(0),
  },
  t => [
    primaryKey({ columns: [t.runId, t.armId, t.rowId, t.sample] }),
    index("idx_eval_row_results_trace").on(t.traceProviderId, t.traceId),
  ],
);

/** One check's result for one (arm, row, sample) run. */
export const evalCheckResults = sqliteTable(
  "eval_check_results",
  {
    runId: text("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    armId: text("arm_id").notNull(),
    rowId: text("row_id").notNull(),
    sample: integer("sample").notNull().default(0),
    checkId: text("check_id").notNull(),
    outcome: text("outcome").notNull(),
    score: real("score"),
    message: text("message"),
    /** JSON. */
    details: text("details"),
    durationMs: real("duration_ms"),
  },
  t => [
    primaryKey({
      columns: [t.runId, t.armId, t.rowId, t.sample, t.checkId],
    }),
  ],
);
