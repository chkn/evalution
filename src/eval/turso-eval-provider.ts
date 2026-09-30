// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * {@link EvalProvider} backed by a Turso/libSQL database. fs-free: takes a
 * connected client, never a path — `openLocalEvalStore` is the Node-side
 * bootstrap. See `specs/evals.md` §E.
 */

import type { Database } from "@tursodatabase/sync";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import type { ExecutionInput } from "../shared/types.ts";
import type { PromptID } from "../trace/trace-types.ts";
import {
  evalCheckResults,
  evalRowResults,
  evalRuns,
  evals,
} from "./db/schema.ts";
import { EvalNotFoundError, type EvalProvider } from "./eval-provider.ts";
import {
  type EvalArm,
  type EvalChangeEvent,
  type EvalCheck,
  type EvalCheckOutcome,
  type EvalCheckResult,
  type EvalCounts,
  type EvalDefinition,
  type EvalDefinitionPatch,
  type EvalInputs,
  type EvalResults,
  type EvalRowResult,
  type EvalRowStatus,
  type EvalRun,
  type EvalRunStatus,
  type EvalRunSummary,
  type EvalSummary,
  emptyCounts,
  type NewEvalDefinition,
  type NewEvalRun,
  type TraceCheckResult,
} from "./eval-types.ts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `prefix` + 12 base-62 characters. */
function mintId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = prefix;
  for (const b of bytes) id += BASE62[b % 62];
  return id;
}

type EvalRow = typeof evals.$inferSelect;
type RunRow = typeof evalRuns.$inferSelect;
type RowResultRow = typeof evalRowResults.$inferSelect;
type CheckResultRow = typeof evalCheckResults.$inferSelect;

function rowToEval(row: EvalRow): EvalDefinition {
  return {
    id: row.id,
    name: row.name,
    prompt: JSON.parse(row.prompt) as PromptID,
    dataset: { providerId: row.datasetProviderId, id: row.datasetId },
    inputs: JSON.parse(row.inputs) as EvalInputs,
    checks: JSON.parse(row.checks) as EvalCheck[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToRun(row: RunRow): EvalRun {
  return {
    id: row.id,
    evalId: row.evalId,
    definition: JSON.parse(row.definition) as EvalDefinition,
    arms: JSON.parse(row.arms) as EvalArm[],
    ...(row.startVersion && { startVersion: row.startVersion }),
    dirty: row.dirty === 1,
    drifted: row.drifted === 1,
    status: row.status as EvalRunStatus,
    concurrency: row.concurrency,
    total: row.total,
    startedAt: row.startedAt,
    ...(row.endedAt !== null && { endedAt: row.endedAt }),
  };
}

function rowToRowResult(row: RowResultRow): EvalRowResult {
  return {
    runId: row.runId,
    armId: row.armId,
    rowId: row.rowId,
    sample: row.sample,
    rowIndex: row.rowIndex,
    rowCells: JSON.parse(row.rowCells) as Record<string, ExecutionInput>,
    ...(row.traceProviderId && { traceProviderId: row.traceProviderId }),
    ...(row.traceId && { traceId: row.traceId }),
    ...(row.version && { version: row.version }),
    ...(row.variation && { variation: row.variation }),
    status: row.status as EvalRowStatus,
    ...(row.error !== null && { error: row.error }),
    ...(row.costUsd !== null && { costUsd: row.costUsd }),
    ...(row.durationMs !== null && { durationMs: row.durationMs }),
    ...(row.traceIncomplete === 1 && { traceIncomplete: true }),
  };
}

function rowToCheckResult(row: CheckResultRow): EvalCheckResult {
  return {
    runId: row.runId,
    armId: row.armId,
    rowId: row.rowId,
    sample: row.sample,
    checkId: row.checkId,
    outcome: row.outcome as EvalCheckOutcome,
    ...(row.score !== null && { score: row.score }),
    ...(row.message !== null && { message: row.message }),
    ...(row.details !== null && { details: JSON.parse(row.details) }),
    ...(row.durationMs !== null && { durationMs: row.durationMs }),
  };
}

/**
 * `EvalProvider` over a Turso/libSQL database via
 * `drizzle-orm/tursodatabase-sync`. Migrations are *not* run here: call
 * `runEvalMigrations` against the same client first.
 */
export class TursoEvalProvider implements EvalProvider {
  readonly id: string;
  readonly displayName?: string;

  private readonly db: ReturnType<
    typeof drizzle<Record<string, never>, Database>
  >;
  private readonly watchers = new Set<(event: EvalChangeEvent) => void>();

  /** Tail of the serialized-operation chain — as `TursoVariationStore.serialize`. */
  private ops: Promise<unknown> = Promise.resolve();

  constructor({
    client,
    id = "turso-evals",
    displayName = "Evals",
  }: {
    /** An already-connected, migrated `@tursodatabase/sync` client. */
    client: Database;
    id?: string;
    displayName?: string;
  }) {
    this.id = id;
    this.displayName = displayName;
    this.db = drizzle({ client });
  }

  /**
   * Runs an operation to completion before the next one starts: the client
   * is a single connection, and overlapping transactions on it fail outright
   * — as does a read that lands in the middle of one. Reads go through here
   * too: results arrive concurrently while a run is in flight.
   */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.ops.then(op, op);
    this.ops = next.catch(() => {});
    return next;
  }

  private emit(event: EvalChangeEvent): void {
    for (const watcher of this.watchers) watcher(event);
  }

  watch(callback: (event: EvalChangeEvent) => void): () => void {
    this.watchers.add(callback);
    return () => this.watchers.delete(callback);
  }

  // #region Evals

  listEvals(): Promise<Omit<EvalSummary, "providerId">[]> {
    return this.serialize(async () => {
      const rows = await this.db
        .select()
        .from(evals)
        .orderBy(desc(evals.updatedAt));
      if (rows.length === 0) return [];

      // The newest run of each eval, then its counts, in two queries rather
      // than one per eval.
      const runs = await this.db
        .select()
        .from(evalRuns)
        .where(
          inArray(
            evalRuns.evalId,
            rows.map(r => r.id),
          ),
        )
        .orderBy(desc(evalRuns.startedAt));
      const latest = new Map<string, RunRow>();
      for (const run of runs) {
        if (!latest.has(run.evalId)) latest.set(run.evalId, run);
      }
      const tallies = await this.tallies([...latest.values()].map(r => r.id));

      return rows.map(row => {
        const def = rowToEval(row);
        const run = latest.get(row.id);
        const tally = run && tallies.get(run.id);
        return {
          id: def.id,
          name: def.name,
          prompt: def.prompt,
          dataset: def.dataset,
          checkCount: def.checks.length,
          updatedAt: def.updatedAt,
          ...(run && {
            lastRun: {
              id: run.id,
              status: run.status as EvalRunStatus,
              startedAt: run.startedAt,
              total: run.total,
              done: tally?.done ?? 0,
              counts: tally?.counts ?? emptyCounts(),
            },
          }),
        };
      });
    });
  }

  getEval(id: string): Promise<EvalDefinition | undefined> {
    return this.serialize(async () => {
      const [row] = await this.db.select().from(evals).where(eq(evals.id, id));
      return row && rowToEval(row);
    });
  }

  async createEval(input: NewEvalDefinition): Promise<EvalDefinition> {
    const now = Date.now();
    const def: EvalDefinition = {
      ...input,
      id: mintId("eval_"),
      createdAt: now,
      updatedAt: now,
    };
    await this.serialize(() =>
      this.db.insert(evals).values({
        id: def.id,
        name: def.name,
        prompt: JSON.stringify(def.prompt),
        datasetProviderId: def.dataset.providerId,
        datasetId: def.dataset.id,
        inputs: JSON.stringify(def.inputs),
        checks: JSON.stringify(def.checks),
        createdAt: def.createdAt,
        updatedAt: def.updatedAt,
      }),
    );
    this.emit({ type: "add", evalId: def.id });
    return def;
  }

  async updateEval(
    id: string,
    patch: EvalDefinitionPatch,
  ): Promise<EvalDefinition> {
    const updated = await this.serialize(async () => {
      const [row] = await this.db.select().from(evals).where(eq(evals.id, id));
      if (!row) throw new EvalNotFoundError(`Eval not found: ${id}`);
      const current = rowToEval(row);
      const next: EvalDefinition = {
        ...current,
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.prompt !== undefined && { prompt: patch.prompt }),
        ...(patch.dataset !== undefined && { dataset: patch.dataset }),
        ...(patch.inputs !== undefined && { inputs: patch.inputs }),
        ...(patch.checks !== undefined && { checks: patch.checks }),
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      };
      await this.db
        .update(evals)
        .set({
          name: next.name,
          prompt: JSON.stringify(next.prompt),
          datasetProviderId: next.dataset.providerId,
          datasetId: next.dataset.id,
          inputs: JSON.stringify(next.inputs),
          checks: JSON.stringify(next.checks),
          updatedAt: next.updatedAt,
        })
        .where(eq(evals.id, id));
      return next;
    });
    this.emit({ type: "update", evalId: id });
    return updated;
  }

  async deleteEval(id: string): Promise<void> {
    const deleted = await this.serialize(() =>
      this.db.transaction(async tx => {
        // `ON DELETE CASCADE` covers this on a client with foreign keys on;
        // deleting explicitly means one that didn't still can't strand rows.
        const runIds = (
          await tx
            .select({ id: evalRuns.id })
            .from(evalRuns)
            .where(eq(evalRuns.evalId, id))
        ).map(r => r.id);
        if (runIds.length > 0) {
          await tx
            .delete(evalCheckResults)
            .where(inArray(evalCheckResults.runId, runIds));
          await tx
            .delete(evalRowResults)
            .where(inArray(evalRowResults.runId, runIds));
          await tx.delete(evalRuns).where(inArray(evalRuns.id, runIds));
        }
        const removed = await tx
          .delete(evals)
          .where(eq(evals.id, id))
          .returning({ id: evals.id });
        return removed.length > 0;
      }),
    );
    if (deleted) this.emit({ type: "remove", evalId: id });
  }

  // #endregion
  // #region Runs

  async createRun(evalId: string, run: NewEvalRun): Promise<EvalRun> {
    const created: EvalRun = {
      ...run,
      id: mintId("run_"),
      evalId,
      status: "running",
      drifted: false,
      startedAt: Date.now(),
    };
    await this.serialize(async () => {
      const [exists] = await this.db
        .select({ id: evals.id })
        .from(evals)
        .where(eq(evals.id, evalId));
      if (!exists) throw new EvalNotFoundError(`Eval not found: ${evalId}`);
      await this.db.insert(evalRuns).values({
        id: created.id,
        evalId,
        definition: JSON.stringify(created.definition),
        arms: JSON.stringify(created.arms),
        startVersion: created.startVersion ?? null,
        dirty: created.dirty ? 1 : 0,
        status: created.status,
        drifted: 0,
        concurrency: created.concurrency,
        total: created.total,
        startedAt: created.startedAt,
      });
    });
    this.emit({ type: "update", evalId, runId: created.id });
    return created;
  }

  async finishRun(
    runId: string,
    status: EvalRunStatus,
    options: { drifted?: boolean } = {},
  ): Promise<void> {
    const evalId = await this.serialize(async () => {
      const [run] = await this.db
        .update(evalRuns)
        .set({
          status,
          endedAt: Date.now(),
          ...(options.drifted !== undefined && {
            drifted: options.drifted ? 1 : 0,
          }),
        })
        .where(eq(evalRuns.id, runId))
        .returning({ evalId: evalRuns.evalId });
      return run?.evalId;
    });
    if (evalId) this.emit({ type: "update", evalId, runId });
  }

  listRuns(evalId: string): Promise<EvalRunSummary[]> {
    return this.serialize(async () => {
      const runs = await this.db
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.evalId, evalId))
        .orderBy(desc(evalRuns.startedAt));
      const tallies = await this.tallies(runs.map(r => r.id));
      return runs.map(row => {
        const run = rowToRun(row);
        const tally = tallies.get(run.id);
        return {
          id: run.id,
          evalId: run.evalId,
          status: run.status,
          arms: run.arms.map(a => ({
            id: a.id,
            label: a.label,
            ...(a.error && { error: a.error }),
          })),
          ...(run.startVersion && { startVersion: run.startVersion }),
          dirty: run.dirty,
          drifted: run.drifted,
          startedAt: run.startedAt,
          ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
          total: run.total,
          done: tally?.done ?? 0,
          counts: tally?.counts ?? emptyCounts(),
        };
      });
    });
  }

  getRun(runId: string): Promise<EvalRun | undefined> {
    return this.serialize(async () => {
      const [row] = await this.db
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.id, runId));
      return row && rowToRun(row);
    });
  }

  /**
   * How many (arm, row) runs each of `runIds` has finished, and how its
   * check results break down.
   */
  private async tallies(
    runIds: string[],
  ): Promise<Map<string, { done: number; counts: EvalCounts }>> {
    const out = new Map<string, { done: number; counts: EvalCounts }>();
    if (runIds.length === 0) return out;
    for (const id of runIds) out.set(id, { done: 0, counts: emptyCounts() });

    const done = await this.db
      .select({ runId: evalRowResults.runId, n: sql<number>`count(*)` })
      .from(evalRowResults)
      .where(inArray(evalRowResults.runId, runIds))
      .groupBy(evalRowResults.runId);
    for (const d of done) out.get(d.runId)!.done = Number(d.n);

    const outcomes = await this.db
      .select({
        runId: evalCheckResults.runId,
        outcome: evalCheckResults.outcome,
        n: sql<number>`count(*)`,
      })
      .from(evalCheckResults)
      .where(inArray(evalCheckResults.runId, runIds))
      .groupBy(evalCheckResults.runId, evalCheckResults.outcome);
    for (const o of outcomes) {
      const counts = out.get(o.runId)!.counts;
      const key = o.outcome as EvalCheckOutcome;
      if (key in counts) counts[key] += Number(o.n);
    }
    return out;
  }

  // #endregion
  // #region Results

  async recordRowResult(result: EvalRowResult): Promise<void> {
    await this.serialize(() =>
      this.db
        .insert(evalRowResults)
        .values({
          runId: result.runId,
          armId: result.armId,
          rowId: result.rowId,
          sample: result.sample,
          rowIndex: result.rowIndex,
          rowCells: JSON.stringify(result.rowCells),
          traceProviderId: result.traceProviderId ?? null,
          traceId: result.traceId ?? null,
          version: result.version ?? null,
          variation: result.variation ?? null,
          status: result.status,
          error: result.error ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null,
          traceIncomplete: result.traceIncomplete ? 1 : 0,
        })
        .onConflictDoNothing(),
    );
  }

  async recordCheckResults(results: EvalCheckResult[]): Promise<void> {
    if (results.length === 0) return;
    await this.serialize(() =>
      this.db
        .insert(evalCheckResults)
        .values(
          results.map(r => ({
            runId: r.runId,
            armId: r.armId,
            rowId: r.rowId,
            sample: r.sample,
            checkId: r.checkId,
            outcome: r.outcome,
            score: r.score ?? null,
            message: r.message ?? null,
            details: r.details === undefined ? null : JSON.stringify(r.details),
            durationMs: r.durationMs ?? null,
          })),
        )
        .onConflictDoNothing(),
    );
  }

  listResults(runId: string): Promise<EvalResults> {
    return this.serialize(async () => {
      const rows = await this.db
        .select()
        .from(evalRowResults)
        .where(eq(evalRowResults.runId, runId))
        .orderBy(evalRowResults.rowIndex, evalRowResults.armId);
      const checks = await this.db
        .select()
        .from(evalCheckResults)
        .where(eq(evalCheckResults.runId, runId));
      return {
        rows: rows.map(rowToRowResult),
        checks: checks.map(rowToCheckResult),
      };
    });
  }

  resultsForTrace(
    traceProviderId: string,
    traceId: string,
  ): Promise<TraceCheckResult[]> {
    return this.serialize(async () => {
      const rows = await this.db
        .select()
        .from(evalRowResults)
        .where(
          and(
            eq(evalRowResults.traceProviderId, traceProviderId),
            eq(evalRowResults.traceId, traceId),
          ),
        );
      const out: TraceCheckResult[] = [];
      for (const row of rows) {
        const [run] = await this.db
          .select()
          .from(evalRuns)
          .where(eq(evalRuns.id, row.runId));
        if (!run) continue;
        const { definition, arms } = rowToRun(run);
        const checks = await this.db
          .select()
          .from(evalCheckResults)
          .where(
            and(
              eq(evalCheckResults.runId, row.runId),
              eq(evalCheckResults.armId, row.armId),
              eq(evalCheckResults.rowId, row.rowId),
              eq(evalCheckResults.sample, row.sample),
            ),
          );
        for (const c of checks) {
          const check = definition.checks.find(d => d.id === c.checkId);
          out.push({
            ...rowToCheckResult(c),
            evalId: definition.id,
            evalName: definition.name,
            checkLabel: check?.label ?? check?.uri ?? c.checkId,
            armLabel: arms.find(a => a.id === row.armId)?.label ?? row.armId,
          });
        }
      }
      return out;
    });
  }

  // #endregion
}
