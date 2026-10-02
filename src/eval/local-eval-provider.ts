// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Node-side (fs-allowed) bootstrap for the local {@link TursoEvalProvider} —
 * the one place a real path gets involved, as `local-variation-store.ts` is
 * for variations.
 */

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import {
  assertSqliteFile,
  createLocalTursoClient,
} from "../trace/db/local-turso-client.ts";
import { mkdirSelfIgnoring } from "../trace/db/self-ignoring-dir.ts";
import { runEvalMigrations } from "./db/migrate.ts";
import type { EvalProvider } from "./eval-provider.ts";
import type {
  EvalChangeEvent,
  EvalCheckResult,
  EvalDefinitionPatch,
  EvalResults,
  EvalRowResult,
  EvalRunStatus,
  NewEvalDefinition,
  NewEvalRun,
} from "./eval-types.ts";
import { TursoEvalProvider } from "./turso-eval-provider.ts";

/**
 * Opens (creating if needed) the eval database at `path`, in a directory
 * that ignores itself, so evals stay out of git without anyone editing their
 * `.gitignore`.
 */
export async function openLocalEvalProvider(
  path: string,
  options: { id?: string; displayName?: string } = {},
): Promise<TursoEvalProvider> {
  await mkdirSelfIgnoring(dirname(path));
  await assertSqliteFile(path);
  const client = await createLocalTursoClient({ path });
  await runEvalMigrations(drizzle({ client }));
  return new TursoEvalProvider({ client, ...options });
}

/** Options for {@link LocalEvalProvider}. */
export interface LocalEvalProviderOptions {
  /**
   * The database file. Absolute, or relative to the current working
   * directory. Created, with its directory, on the first write.
   *
   * @default "./.evalution/evals/evals.db"
   */
  path?: string;
  id?: string;
  displayName?: string;
}

/**
 * The default eval provider: a {@link TursoEvalProvider} over one SQLite file
 * that isn't created until something is written. Until then every read
 * answers "nothing" — so opening the app never leaves a database behind.
 */
export class LocalEvalProvider implements EvalProvider {
  readonly id: string;
  readonly displayName?: string;
  /** The resolved (absolute) database path. */
  readonly path: string;

  private opened?: Promise<TursoEvalProvider>;
  private readonly watchers = new Set<(event: EvalChangeEvent) => void>();

  constructor(options: LocalEvalProviderOptions = {}) {
    this.id = options.id ?? "local-evals";
    this.displayName = options.displayName ?? "Evals";
    this.path = resolve(options.path ?? "./.evalution/evals/evals.db");
  }

  /** The store, creating it if needed. Set synchronously, so concurrent first writes share one open. */
  private open(): Promise<TursoEvalProvider> {
    if (!this.opened) {
      this.opened = openLocalEvalProvider(this.path, { id: this.id }).then(
        store => {
          store.watch(event => {
            for (const watcher of this.watchers) watcher(event);
          });
          return store;
        },
      );
      // A failed open may succeed later (the directory was read-only, say).
      this.opened.catch(() => {
        this.opened = undefined;
      });
    }
    return this.opened;
  }

  /** The store if it exists yet, without creating it. */
  private async existing(): Promise<TursoEvalProvider | undefined> {
    const exists =
      !!this.opened ||
      (await access(this.path).then(
        () => true,
        () => false,
      ));
    return exists ? this.open() : undefined;
  }

  watch(callback: (event: EvalChangeEvent) => void): () => void {
    this.watchers.add(callback);
    return () => this.watchers.delete(callback);
  }

  async listEvals() {
    return (await (await this.existing())?.listEvals()) ?? [];
  }
  async getEval(id: string) {
    return (await this.existing())?.getEval(id);
  }
  async createEval(input: NewEvalDefinition) {
    return (await this.open()).createEval(input);
  }
  async updateEval(id: string, patch: EvalDefinitionPatch) {
    return (await this.open()).updateEval(id, patch);
  }
  async deleteEval(id: string) {
    await (await this.existing())?.deleteEval(id);
  }
  async createRun(evalId: string, run: NewEvalRun) {
    return (await this.open()).createRun(evalId, run);
  }
  async finishRun(
    runId: string,
    status: EvalRunStatus,
    options?: { drifted?: boolean },
  ) {
    await (await this.open()).finishRun(runId, status, options);
  }
  async interruptRuns() {
    return (await (await this.existing())?.interruptRuns()) ?? 0;
  }
  async listRuns(evalId: string) {
    return (await (await this.existing())?.listRuns(evalId)) ?? [];
  }
  async getRun(runId: string) {
    return (await this.existing())?.getRun(runId);
  }
  async deleteRun(runId: string) {
    await (await this.existing())?.deleteRun(runId);
  }
  async recordRowResult(result: EvalRowResult) {
    await (await this.open()).recordRowResult(result);
  }
  async recordCheckResults(results: EvalCheckResult[]) {
    await (await this.open()).recordCheckResults(results);
  }
  async listResults(runId: string): Promise<EvalResults> {
    return (
      (await (await this.existing())?.listResults(runId)) ?? {
        rows: [],
        checks: [],
      }
    );
  }
  async resultsForTrace(traceProviderId: string, traceId: string) {
    return (
      (await (
        await this.existing()
      )?.resultsForTrace(traceProviderId, traceId)) ?? []
    );
  }
}
