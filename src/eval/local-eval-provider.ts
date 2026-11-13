// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Node-side (fs-allowed) bootstrap for the local {@link TursoEvalProvider} —
 * the one place a real path gets involved, as `local-variation-store.ts` is
 * for variations.
 */

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import type { DatabaseSync } from "../sync/database-sync.ts";
import {
  type LocalDatabaseSync,
  openLocalDatabase,
  startSyncing,
} from "../sync/local-database.ts";
import { PauseGate } from "../sync/pause-gate.ts";
import type { WorkspaceSync } from "../sync/workspace-sync.ts";
import { assertSqliteFile } from "../trace/db/local-turso-client.ts";
import { mkdirSelfIgnoring } from "../trace/db/self-ignoring-dir.ts";
import { EVAL_SCHEMA_VERSION, runEvalMigrations } from "./db/migrate.ts";
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

const migrate = (client: Database) => runEvalMigrations(drizzle({ client }));

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
  const client = await openLocalDatabase({ path, migrate });
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
  /**
   * Also names the database in Evalution Cloud when the project is linked:
   * changing it starts a new cloud copy.
   */
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
  private sync: DatabaseSync | undefined;
  /** The open file, for sync. */
  private client: Database | undefined;
  /** Holds operations while sync swaps the database file. */
  private readonly gate = new PauseGate();

  constructor(options: LocalEvalProviderOptions = {}) {
    this.id = options.id ?? "local-evals";
    this.displayName = options.displayName ?? "Evals";
    this.path = resolve(options.path ?? "./.evalution/evals/evals.db");
  }

  /**
   * Syncs the database with the linked project's copy (named by this
   * provider's id), once `setUpProject` hands this the project's sync. Opens
   * (and creates) the database at once, since the project may already have
   * evals from another machine; a database already open starts syncing as
   * it is.
   *
   * @internal Not public API yet.
   */
  _ecSetSync(workspace: WorkspaceSync): void {
    if (this.sync) return;
    this.sync = workspace.database(
      { kind: "evals", provider: this.id },
      EVAL_SCHEMA_VERSION,
    );
    const opening = this.opened;
    (opening ? opening.then(() => this.startSyncing()) : this.open()).catch(
      err =>
        console.error(`Could not open the eval database at ${this.path}:`, err),
    );
  }

  /** What syncing the file needs, once there's a sync. */
  private syncHooks(): LocalDatabaseSync | undefined {
    const database = this.sync;
    return (
      database && {
        database,
        // What a pull brings in names no eval: say the list has changed.
        onPulled: () => this.emit({ type: "update", evalId: "" }),
        pause: during => this.gate.pause(during),
        reopen: () => {
          this.opened = undefined;
          this.client = undefined;
          return this.open();
        },
      }
    );
  }

  /** Starts syncing the open file. */
  private async startSyncing(): Promise<void> {
    const sync = this.syncHooks();
    const client = this.client;
    if (!sync || !client) return;
    await sync.database.prepare();
    await startSyncing({ path: this.path, client, migrate, sync });
  }

  /** The store, creating it if needed. Set synchronously, so concurrent first writes share one open. */
  private open(): Promise<TursoEvalProvider> {
    if (!this.opened) {
      const opening = this.openStore().then(store => {
        store.watch(event => this.emit(event));
        return store;
      });
      this.opened = opening;
      // A failed open may succeed later (the directory was read-only, say).
      opening.catch(() => {
        if (this.opened === opening) this.opened = undefined;
      });
    }
    return this.opened;
  }

  private async openStore(): Promise<TursoEvalProvider> {
    await mkdirSelfIgnoring(dirname(this.path));
    await assertSqliteFile(this.path);
    // Before connecting, so a database new to this machine starts from the
    // cloud's copy.
    await this.sync?.prepare();
    const client = await openLocalDatabase({
      path: this.path,
      migrate,
      sync: () => this.syncHooks(),
    });
    this.client = client;
    return new TursoEvalProvider({
      client,
      id: this.id,
      displayName: this.displayName,
    });
  }

  private emit(event: EvalChangeEvent): void {
    for (const watcher of this.watchers) watcher(event);
  }

  /** Runs `op` on the store, creating it if needed. */
  private withStore<T>(op: (store: TursoEvalProvider) => Promise<T>) {
    return this.gate.run(async () => op(await this.open()));
  }

  /** Runs `op` on the store if it exists yet, without creating it. */
  private ifOpen<T>(
    op: (store: TursoEvalProvider) => Promise<T>,
    otherwise: T,
  ): Promise<T> {
    return this.gate.run(async () => {
      const store = await this.existing();
      return store ? op(store) : otherwise;
    });
  }

  /** `op`'s result, after telling the sync the database was written to. */
  private async wrote<T>(op: Promise<T>): Promise<T> {
    const result = await op;
    this.sync?.noteWrite();
    return result;
  }

  /** The store if it exists yet, without creating it. */
  private async existing(): Promise<TursoEvalProvider | undefined> {
    const exists =
      !!this.opened ||
      !!this.sync ||
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

  listEvals() {
    return this.ifOpen(store => store.listEvals(), []);
  }
  getEval(id: string) {
    return this.ifOpen(store => store.getEval(id), undefined);
  }
  createEval(input: NewEvalDefinition) {
    return this.wrote(this.withStore(store => store.createEval(input)));
  }
  updateEval(id: string, patch: EvalDefinitionPatch) {
    return this.wrote(this.withStore(store => store.updateEval(id, patch)));
  }
  deleteEval(id: string) {
    return this.wrote(this.ifOpen(store => store.deleteEval(id), undefined));
  }
  createRun(evalId: string, run: NewEvalRun) {
    return this.wrote(this.withStore(store => store.createRun(evalId, run)));
  }
  finishRun(
    runId: string,
    status: EvalRunStatus,
    options?: { drifted?: boolean },
  ) {
    return this.wrote(
      this.withStore(store => store.finishRun(runId, status, options)),
    );
  }
  interruptRuns() {
    return this.wrote(this.ifOpen(store => store.interruptRuns(), 0));
  }
  listRuns(evalId: string) {
    return this.ifOpen(store => store.listRuns(evalId), []);
  }
  getRun(runId: string) {
    return this.ifOpen(store => store.getRun(runId), undefined);
  }
  deleteRun(runId: string) {
    return this.wrote(this.ifOpen(store => store.deleteRun(runId), undefined));
  }
  recordRowResult(result: EvalRowResult) {
    return this.wrote(this.withStore(store => store.recordRowResult(result)));
  }
  recordCheckResults(results: EvalCheckResult[]) {
    return this.wrote(
      this.withStore(store => store.recordCheckResults(results)),
    );
  }
  listResults(runId: string): Promise<EvalResults> {
    return this.ifOpen(store => store.listResults(runId), {
      rows: [],
      checks: [],
    });
  }
  listTraceRuns() {
    return this.ifOpen(store => store.listTraceRuns(), []);
  }
  resultsForTrace(traceProviderId: string, traceId: string) {
    return this.ifOpen(
      store => store.resultsForTrace(traceProviderId, traceId),
      [],
    );
  }
}
