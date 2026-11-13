// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { access, constants, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import type { ColumnPath, DatasetColumnSpec } from "../shared/column-paths.ts";
import type { PropDefinition } from "../shared/types.ts";
import {
  type LocalDatabaseSync,
  openLocalDatabase,
  startSyncing,
} from "../sync/local-database.ts";
import { PauseGate } from "../sync/pause-gate.ts";
import type { WorkspaceSync } from "../sync/workspace-sync.ts";
import { assertSqliteFile } from "../trace/db/local-turso-client.ts";
import { runQueryInWorker } from "../trace/db/query-worker.ts";
import type {
  SqlQueryOptions,
  SqlQueryResult,
} from "../trace/db/read-only-query.ts";
import { mkdirSelfIgnoring } from "../trace/db/self-ignoring-dir.ts";
import {
  isValidDatasetId,
  slugifyDatasetName,
  uniqueDatasetId,
} from "./dataset-ids.ts";
import {
  type CreateDatasetInput,
  DatasetNotFoundError,
  type DatasetProvider,
  type ListRowsOptions,
  type NewDatasetRow,
} from "./dataset-provider.ts";
import type {
  Dataset,
  DatasetChangeEvent,
  DatasetField,
  DatasetPathChild,
  DatasetRow,
  DatasetRowsOverview,
  DatasetRowUpdate,
  DatasetSummary,
} from "./dataset-types.ts";
import { mergeDatasetTables } from "./db/merge.ts";
import { DATASET_SCHEMA_VERSION, runDatasetMigrations } from "./db/migrate.ts";
import { TursoDatasetProvider } from "./turso-dataset-provider.ts";

/** Extension of a dataset file. */
const DB_EXT = ".db";

/**
 * Files Turso keeps beside a database, removed with it. `-shm` is SQLite's
 * own, listed in case a file was last opened by another SQLite build.
 */
const SIDECARS = ["-wal", "-shm", "-info", "-changes"];

/** What opening one dataset file produced. */
type Entry =
  | {
      ok: true;
      client: Database;
      inner: TursoDatasetProvider;
      /**
       * The dataset's id *inside* the file. The file name is the id this
       * provider reports, so a file copied to a new name is a new dataset
       * even though its row still says the old id.
       */
      innerId: string;
      unwatch: () => void;
    }
  | { ok: false; error: string };

/** Options for {@link LocalDirectoryDatasetProvider}. */
export interface LocalDirectoryDatasetProviderOptions {
  /**
   * The directory holding one `<id>.db` file per dataset. Absolute, or
   * relative to the current working directory. Created, with a `.gitignore`,
   * on the first create.
   *
   * @default "./.evalution/datasets"
   */
  dir?: string;
  /**
   * Also names the datasets in Evalution Cloud when the project is linked:
   * changing it starts new cloud copies.
   */
  id?: string;
  displayName?: string;
  description?: string;
}

const migrateDataset = (client: Database) =>
  runDatasetMigrations(drizzle({ client }));

/**
 * A {@link DatasetProvider} that keeps **one SQLite file per dataset** in a
 * directory, each opened lazily as a {@link TursoDatasetProvider}.
 *
 * - Lists by scanning the directory, so a file copied in by hand shows up on
 *   the next list without a watcher.
 * - Writes nothing to disk until the first dataset is created; the directory
 *   is then created with a `.gitignore` of `*`, so it ignores its own
 *   contents, `.gitignore` included.
 * - A file that won't open, or doesn't hold exactly one dataset, is listed
 *   with an `error` and reported once — never thrown from a list.
 */
export class LocalDirectoryDatasetProvider implements DatasetProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  /** The resolved (absolute) directory — see {@link LocalDirectoryDatasetProviderOptions.dir}. */
  readonly dir: string;

  /**
   * One open per file, cached as a promise and set synchronously — two sync
   * clients over one file fail with "database is busy", so concurrent callers
   * must share an open rather than race to start their own.
   */
  private readonly entries = new Map<string, Promise<Entry>>();
  private readonly watchers = new Set<(event: DatasetChangeEvent) => void>();
  /** Files whose failure has already been logged, so it's reported once. */
  private readonly reported = new Set<string>();
  /** Tail of the create chain: id choice and file creation are one step. */
  private creates: Promise<unknown> = Promise.resolve();
  private sync: WorkspaceSync | undefined;
  /** Per file: holds operations while sync swaps it. */
  private readonly gates = new Map<string, PauseGate>();

  constructor(options: LocalDirectoryDatasetProviderOptions = {}) {
    this.id = options.id ?? "local-datasets";
    this.displayName = options.displayName ?? "Local Datasets";
    this.description =
      options.description ??
      "Stores each dataset in its own SQLite file in a local directory.";
    this.dir = resolve(options.dir ?? "./.evalution/datasets");
  }

  /**
   * Syncs each dataset with the linked project's copy (named by this
   * provider's id and the dataset's), once `setUpProject` hands this the
   * project's sync. A dataset the project has in the cloud but this machine
   * doesn't is fetched whenever the sync pulls, and deleting a dataset
   * deletes it from the cloud. Datasets already open start syncing as they
   * are.
   *
   * @internal Not public API yet.
   */
  _ecSetSync(workspace: WorkspaceSync): void {
    if (this.sync) return;
    this.sync = workspace;
    workspace.onPull(() => this.fetchRemoteDatasets());
    for (const [datasetId, opening] of this.entries) {
      void opening.then(async entry => {
        if (!entry.ok) return;
        const sync = this.syncHooksFor(datasetId);
        if (!sync) return;
        try {
          await sync.database.prepare();
          await startSyncing({
            path: this.pathFor(datasetId),
            client: entry.client,
            migrate: migrateDataset,
            sync,
          });
        } catch (err) {
          console.warn(
            `⚠️ Couldn't start syncing the dataset ${datasetId}:`,
            err,
          );
        }
      });
    }
  }

  /** What syncing `datasetId`'s file needs, once there's a sync. */
  private syncHooksFor(datasetId: string): LocalDatabaseSync | undefined {
    const database = this.datasetSync(datasetId);
    return (
      database && {
        database,
        onPulled: () => this.emit({ type: "update", datasetId }),
        pause: during => this.gateFor(datasetId).pause(during),
        reopen: () => this.reopenEntry(datasetId),
        merge: mergeDatasetTables,
        // A dataset synced before, made again since: start over from it.
        replaceSuperseded: true,
      }
    );
  }

  private gateFor(datasetId: string): PauseGate {
    let gate = this.gates.get(datasetId);
    if (!gate) {
      gate = new PauseGate();
      this.gates.set(datasetId, gate);
    }
    return gate;
  }

  /** Runs `op` on `datasetId`'s file, after any swap of it. */
  private on<T>(datasetId: string, op: () => Promise<T>): Promise<T> {
    return this.gateFor(datasetId).run(op);
  }

  private datasetSync(datasetId: string) {
    return this.sync?.database(
      { kind: "dataset", provider: this.id, key: datasetId },
      DATASET_SCHEMA_VERSION,
    );
  }

  /**
   * Opens this machine's datasets, so each syncs — one made before the
   * project was linked is brought into it — and fetches the datasets the
   * project has in the cloud that this machine doesn't, announcing each as
   * added. Chained with creates, so it can't open a file a create is making.
   */
  private fetchRemoteDatasets(): Promise<void> {
    const next = this.creates.then(async () => {
      const local = new Set(await this.fileIds());
      for (const id of local) {
        if (!this.entries.has(id)) await this.openEntry(id);
      }
      const remote = await this.sync?.remoteDatasetIds(this.id);
      if (!remote) return;
      for (const id of remote) {
        if (!isValidDatasetId(id) || local.has(id) || this.entries.has(id)) {
          continue;
        }
        // Without the cloud's copy to start from, the file would be empty.
        const sync = this.datasetSync(id);
        await sync?.prepare();
        if (!sync?.isAvailable) continue;
        await mkdirSelfIgnoring(this.dir);
        const entry = await this.openEntry(id);
        if (entry.ok) this.emit({ type: "add", datasetId: id });
      }
    });
    this.creates = next.catch(() => {});
    return next;
  }

  private pathFor(datasetId: string): string {
    return join(this.dir, `${datasetId}${DB_EXT}`);
  }

  private emit(event: DatasetChangeEvent): void {
    for (const watcher of this.watchers) watcher(event);
  }

  watch(callback: (event: DatasetChangeEvent) => void): () => void {
    this.watchers.add(callback);
    return () => this.watchers.delete(callback);
  }

  /** Ids of every `*.db` file in the directory; empty before it exists. */
  private async fileIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter(n => n.endsWith(DB_EXT))
      .map(n => n.slice(0, -DB_EXT.length))
      .filter(isValidDatasetId)
      .sort();
  }

  /**
   * The open entry for `datasetId`, opening its file if it exists. Never
   * creates a file: `undefined` when there is none (or the id couldn't name
   * one).
   */
  private async entryFor(datasetId: string): Promise<Entry | undefined> {
    const cached = this.entries.get(datasetId);
    if (cached) return cached;
    if (!isValidDatasetId(datasetId)) return undefined;
    try {
      await access(this.pathFor(datasetId), constants.R_OK | constants.W_OK);
    } catch {
      return undefined;
    }
    return this.openEntry(datasetId);
  }

  /**
   * Opens (and migrates) `datasetId`'s file, caching the result. `create`
   * says the dataset is being made now, which may reuse a deleted one's id.
   */
  private openEntry(
    datasetId: string,
    { create = false }: { create?: boolean } = {},
  ): Promise<Entry> {
    const cached = this.entries.get(datasetId);
    if (cached) return cached;
    const opening = this.openUncached(datasetId, create);
    this.entries.set(datasetId, opening);
    return opening;
  }

  private async openUncached(
    datasetId: string,
    create: boolean,
  ): Promise<Entry> {
    const path = this.pathFor(datasetId);
    let client: Database | undefined;
    try {
      await assertSqliteFile(path);
      // Before connecting, so a dataset new to this machine starts from the
      // cloud's copy.
      await this.datasetSync(datasetId)?.prepare({ create });
      client = await openLocalDatabase({
        path,
        migrate: migrateDataset,
        sync: () => this.syncHooksFor(datasetId),
      });
      const inner = new TursoDatasetProvider({
        client,
        runQuery: (query, options) => runQueryInWorker(path, query, options),
        id: this.id,
      });
      const found = await inner.listDatasets();
      // A fresh file holds nothing until `createDataset` fills it; the
      // caller creating it is the only one that ever sees it empty.
      if (found.length > 1) {
        throw new Error(
          `holds ${found.length} datasets; a dataset file must hold exactly one`,
        );
      }
      const innerId = found[0]?.id ?? datasetId;
      const unwatch = inner.watch(event => {
        this.emit({ type: event.type, datasetId });
        this.datasetSync(datasetId)?.noteWrite();
      });
      return { ok: true, client, inner, innerId, unwatch };
    } catch (err) {
      await client?.close().catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      if (!this.reported.has(datasetId)) {
        this.reported.add(datasetId);
        console.error(
          `Could not open the dataset file at ${path} — it will be listed with an error.\n`,
          err,
        );
      }
      return { ok: false, error };
    }
  }

  /** Opens `datasetId`'s file again, after sync swapped it (and closed the old one). */
  private async reopenEntry(datasetId: string): Promise<Entry> {
    const old = await this.entries.get(datasetId);
    if (old?.ok) old.unwatch();
    this.entries.delete(datasetId);
    const entry = await this.openEntry(datasetId);
    // The adopted copy may hold rows from the cloud.
    if (entry.ok) this.emit({ type: "update", datasetId });
    return entry;
  }

  /** The open entry for `datasetId`, or a {@link DatasetNotFoundError}. */
  private async requireEntry(
    datasetId: string,
  ): Promise<Extract<Entry, { ok: true }>> {
    const entry = await this.entryFor(datasetId);
    if (!entry) throw new DatasetNotFoundError(datasetId);
    if (!entry.ok) {
      throw new Error(
        `Dataset ${datasetId} could not be opened: ${entry.error}`,
      );
    }
    return entry;
  }

  /** `dataset` with its id rewritten to the file's. */
  private withFileId(datasetId: string, dataset: Dataset): Dataset {
    return { ...dataset, id: datasetId };
  }

  async listDatasets(): Promise<DatasetSummary[]> {
    // A file being swapped may be missing for a moment.
    const swapping = [...this.gates]
      .filter(([, gate]) => gate.isPaused)
      .map(([id]) => id);
    const ids = [...new Set([...(await this.fileIds()), ...swapping])].sort();
    // A file removed by hand since the last list: let go of its client.
    const present = new Set(ids);
    for (const [id, opening] of this.entries) {
      if (present.has(id)) continue;
      this.entries.delete(id);
      void opening.then(entry => {
        if (!entry.ok) return;
        entry.unwatch();
        return entry.client.close();
      });
    }
    const summaries = await Promise.all(
      ids.map(id => this.on(id, () => this.summarize(id))),
    );
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async summarize(id: string): Promise<DatasetSummary> {
    const entry = await this.openEntry(id);
    if (!entry.ok) {
      const mtime = await stat(this.pathFor(id)).then(
        s => s.mtimeMs,
        () => 0,
      );
      return {
        providerId: this.id,
        id,
        name: id,
        rowCount: 0,
        fields: [],
        updatedAt: mtime,
        error: entry.error,
      };
    }
    const [summary] = await entry.inner.listDatasets();
    if (!summary) {
      return {
        providerId: this.id,
        id,
        name: id,
        rowCount: 0,
        fields: [],
        updatedAt: 0,
        error: "holds no dataset",
      };
    }
    return { ...summary, id };
  }

  getDataset(datasetId: string): Promise<Dataset | undefined> {
    return this.on(datasetId, async () => {
      const entry = await this.entryFor(datasetId);
      if (!entry?.ok) return undefined;
      const dataset = await entry.inner.getDataset(entry.innerId);
      return dataset && this.withFileId(datasetId, dataset);
    });
  }

  listRows(
    datasetId: string,
    options?: ListRowsOptions,
  ): Promise<DatasetRow[]> {
    return this.on(datasetId, async () => {
      const entry = await this.entryFor(datasetId);
      if (!entry?.ok) return [];
      return entry.inner.listRows(entry.innerId, options);
    });
  }

  describeRows(datasetId: string): Promise<DatasetRowsOverview> {
    return this.on(datasetId, async () => {
      const entry = await this.entryFor(datasetId);
      if (!entry?.ok) return { rowCount: 0, fields: {}, instances: {} };
      return entry.inner.describeRows(entry.innerId);
    });
  }

  describePath(
    datasetId: string,
    path: ColumnPath,
  ): Promise<DatasetPathChild[]> {
    return this.on(datasetId, async () => {
      const entry = await this.entryFor(datasetId);
      if (!entry?.ok) return [];
      return entry.inner.describePath(entry.innerId, path);
    });
  }

  /**
   * Creates `<slug>.db` (`<slug>-2.db` on collision) and the dataset inside
   * it. Creates are chained, so two at once can't pick the same id or open
   * one file twice.
   */
  createDataset(input: CreateDatasetInput): Promise<Dataset> {
    const next = this.creates.then(() => this.createNow(input));
    this.creates = next.catch(() => {});
    return next;
  }

  private async createNow(input: CreateDatasetInput): Promise<Dataset> {
    // A directory that ignores its own contents is the only version that
    // works without telling anyone to edit their own `.gitignore`.
    await mkdirSelfIgnoring(this.dir);
    // Including the project's datasets this machine hasn't fetched yet: one
    // of the same id would be the same file.
    const existing = new Set([
      ...(await this.fileIds()),
      ...((await this.sync?.remoteDatasetIds(this.id)) ?? []),
    ]);
    const id = uniqueDatasetId(
      slugifyDatasetName(input.name),
      candidate => existing.has(candidate) || this.entries.has(candidate),
    );
    const entry = await this.openEntry(id, { create: true });
    if (!entry.ok) {
      this.entries.delete(id);
      throw new Error(
        `Could not create dataset file for ${id}: ${entry.error}`,
      );
    }
    return this.on(id, async () => {
      const opened = await this.requireEntry(id);
      const created = await opened.inner.createDataset(input, { id });
      return this.withFileId(id, created);
    });
  }

  /** Runs `op` on `datasetId`'s open entry, or throws if there's none. */
  private withEntry<T>(
    datasetId: string,
    op: (entry: Extract<Entry, { ok: true }>) => Promise<T>,
  ): Promise<T> {
    return this.on(datasetId, async () =>
      op(await this.requireEntry(datasetId)),
    );
  }

  renameDataset(datasetId: string, name: string): Promise<Dataset> {
    return this.withEntry(datasetId, async entry =>
      this.withFileId(
        datasetId,
        await entry.inner.renameDataset(entry.innerId, name),
      ),
    );
  }

  /**
   * Closes the file's client, then removes it and its sidecars. When
   * syncing, it's deleted from the cloud too, and so from every machine.
   */
  async deleteDataset(datasetId: string): Promise<void> {
    if (!isValidDatasetId(datasetId)) return;
    // First, so nothing syncs to the copy as it goes.
    await this.sync?.deleteDataset(this.id, datasetId);
    await this.on(datasetId, async () => {
      const entry = await this.entries.get(datasetId);
      this.entries.delete(datasetId);
      this.reported.delete(datasetId);
      if (entry?.ok) {
        entry.unwatch();
        await entry.client.close();
      }
      const path = this.pathFor(datasetId);
      let removed = false;
      for (const file of [path, ...SIDECARS.map(s => path + s)]) {
        try {
          await unlink(file);
          if (file === path) removed = true;
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
      }
      if (removed) this.emit({ type: "remove", datasetId });
    });
  }

  addRows(datasetId: string, rows: NewDatasetRow[]): Promise<DatasetRow[]> {
    return this.withEntry(datasetId, entry =>
      entry.inner.addRows(entry.innerId, rows),
    );
  }

  updateRows(datasetId: string, updates: DatasetRowUpdate[]): Promise<void> {
    return this.withEntry(datasetId, entry =>
      entry.inner.updateRows(entry.innerId, updates),
    );
  }

  deleteRows(datasetId: string, rowIds: readonly string[]): Promise<number> {
    return this.on(datasetId, async () => {
      const entry = await this.entryFor(datasetId);
      if (!entry?.ok) return 0;
      return entry.inner.deleteRows(entry.innerId, rowIds);
    });
  }

  addField(datasetId: string, def: PropDefinition): Promise<DatasetField> {
    return this.withEntry(datasetId, entry =>
      entry.inner.addField(entry.innerId, def),
    );
  }

  renameField(
    datasetId: string,
    fieldId: string,
    name: string,
  ): Promise<DatasetField> {
    return this.withEntry(datasetId, entry =>
      entry.inner.renameField(entry.innerId, fieldId, name),
    );
  }

  deleteField(datasetId: string, fieldId: string): Promise<void> {
    return this.withEntry(datasetId, entry =>
      entry.inner.deleteField(entry.innerId, fieldId),
    );
  }

  setColumns(
    datasetId: string,
    columns: DatasetColumnSpec[],
    rowLabel: ColumnPath | undefined,
  ): Promise<Dataset> {
    return this.withEntry(datasetId, async entry =>
      this.withFileId(
        datasetId,
        await entry.inner.setColumns(entry.innerId, columns, rowLabel),
      ),
    );
  }

  queryRows(
    datasetId: string,
    sql: string,
    options?: SqlQueryOptions,
  ): Promise<SqlQueryResult> {
    return this.withEntry(datasetId, entry =>
      entry.inner.queryRows(entry.innerId, sql, options),
    );
  }

  /** Closes every open file. The provider reopens them on next use. */
  async close(): Promise<void> {
    const entries = await Promise.all(this.entries.values());
    this.entries.clear();
    for (const entry of entries) {
      if (entry.ok) {
        entry.unwatch();
        await entry.client.close();
      }
    }
  }
}
