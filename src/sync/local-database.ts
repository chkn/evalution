// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Opening a local database file, and bringing it into a linked project's
 * sync. See PLAN §6 in the cloud repo.
 *
 * A file records the cloud databases it has synced with in
 * {@link SYNC_LINKS_TABLE}. It syncs only with one it has a link to. A file
 * that has never synced doesn't record its changes for sync, since they'd
 * only bloat it, so it can't simply start syncing. Instead it's *adopted*:
 *
 * 1. A copy of the cloud's database is made beside it (`<file>.adopting`).
 * 2. With the provider's operations paused, the file's rows are copied in.
 * 3. The copy takes the file's place, and the provider reopens it. Sync
 *    pushes the copied rows like any other change.
 *
 * Only step 3 can't simply be started over. A small state file records how
 * far it got, so opening the file finishes it after a crash.
 */

import { constants } from "node:fs";
import {
  copyFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { SyncDatabaseCredentials } from "@evalution/sdk";
import { connect, type Database } from "@tursodatabase/sync";
import { createLocalTursoClient } from "../trace/db/local-turso-client.ts";
import { MIGRATIONS_TABLE } from "../trace/db/migrate.ts";
import type { AttachOptions, DatabaseSync } from "./database-sync.ts";

/** The table recording which cloud databases a file has synced with. */
export const SYNC_LINKS_TABLE = "evalution_sync_links";

/** One cloud database a file has synced with. */
export interface SyncLink {
  syncId: string;
  projectId: string;
}

/** Files Turso keeps beside a database. `-shm` is SQLite's own, in case another build opened it. */
const SIDECARS = ["-wal", "-shm", "-info", "-changes"];

const ADOPTING = ".adopting";
/** Holds the swap's progress: `replace`, then `place`. */
const SWAP_STATE = ".adopted";

/** Rows read and written at a time when copying. */
const COPY_BATCH = 500;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function all(db: Database, sql: string, ...args: unknown[]) {
  return (await (await db.prepare(sql)).all(...args)) as Record<
    string,
    unknown
  >[];
}

async function tableNames(db: Database): Promise<Set<string>> {
  const rows = await all(
    db,
    "SELECT name FROM sqlite_schema WHERE type = 'table'",
  );
  return new Set(rows.map(row => String(row.name)));
}

/** The cloud databases `db` has synced with. */
export async function readSyncLinks(db: Database): Promise<SyncLink[]> {
  if (!(await tableNames(db)).has(SYNC_LINKS_TABLE)) return [];
  const rows = await all(
    db,
    `SELECT sync_id, project_id FROM ${SYNC_LINKS_TABLE}`,
  );
  return rows.map(row => ({
    syncId: String(row.sync_id),
    projectId: String(row.project_id),
  }));
}

/** Records that `db` holds the rows of the cloud database `credentials` name. */
export async function recordSyncLink(
  db: Database,
  { syncId, projectId }: Pick<SyncDatabaseCredentials, "syncId" | "projectId">,
): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${SYNC_LINKS_TABLE} (sync_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, linked_at INTEGER NOT NULL)`,
  );
  await (
    await db.prepare(
      `INSERT INTO ${SYNC_LINKS_TABLE} (sync_id, project_id, linked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    )
  ).run(syncId, projectId, Date.now());
}

/**
 * Stops `db`'s connection recording changes for sync, and drops what it has
 * recorded. Only for a file that has never synced: it has nowhere to push
 * them, and syncing starts by adopting the file, which doesn't need them.
 */
export async function stopRecordingChanges(db: Database): Promise<void> {
  await db.exec("PRAGMA capture_data_changes_conn('off')");
  if ((await tableNames(db)).has("turso_cdc")) {
    await db.exec("DELETE FROM turso_cdc");
  }
}

function filesOf(path: string): string[] {
  return [path, ...SIDECARS.map(suffix => path + suffix)];
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function removeDatabase(path: string): Promise<void> {
  await Promise.all(filesOf(path).map(file => rm(file, { force: true })));
}

/** Writes the swap's state so no crash leaves it half written. */
async function writeSwapState(path: string, state: "replace" | "place") {
  const file = path + SWAP_STATE;
  await writeFile(`${file}.tmp`, state);
  await rename(`${file}.tmp`, file);
}

/**
 * Puts the adopted copy in the file's place. `replace` removes the file;
 * `place` copies the adopted files in, then removes them. Each step can be
 * run again, so whichever a crash interrupted is finished on the next open.
 *
 * Copied, not renamed: `@tursodatabase/sync` 0.7 remembers a closed
 * database by its file, not its path, until it's garbage collected, so a
 * renamed file reopened in the same process is taken for the old path's,
 * and fails to open. A copy is a new file. (A clone, where the file system
 * can, so it's instant.) The closed database also keeps its files open
 * until then, so their inodes can't be reused meanwhile.
 */
async function finishSwap(path: string): Promise<void> {
  const file = path + SWAP_STATE;
  if ((await readFile(file, "utf8")) === "replace") {
    await removeDatabase(path);
    await writeSwapState(path, "place");
  }
  const adopted = filesOf(path + ADOPTING);
  for (const [i, target] of filesOf(path).entries()) {
    const source = adopted[i] as string;
    if (await exists(source)) {
      await copyFile(source, target, constants.COPYFILE_FICLONE);
    }
  }
  await removeDatabase(path + ADOPTING);
  await rm(file, { force: true });
}

/**
 * Finishes a swap a crash interrupted, or discards an adoption that hadn't
 * got that far: it starts over once the file is open.
 */
export async function recoverAdoption(path: string): Promise<void> {
  if (await exists(path + SWAP_STATE)) {
    await finishSwap(path);
    return;
  }
  await removeDatabase(path + ADOPTING);
}

/** How {@link copyTable} reads and writes some of a table's columns. */
export interface CopyTableOptions {
  /** SQL that reads a column, by column: `json(cells)`, say. */
  read?: Record<string, string>;
  /** SQL taking the column's value, by column: `jsonb(?)`, say. */
  write?: Record<string, string>;
  /** Changes a row before it's written. */
  map?: (row: Record<string, unknown>) => Record<string, unknown>;
}

async function columnNames(db: Database, table: string): Promise<string[]> {
  const rows = await all(db, "SELECT name FROM pragma_table_info(?)", table);
  return rows.map(row => String(row.name));
}

/**
 * Copies `table`'s rows from one database into another, keeping the rows
 * already there. Copies the columns both have.
 */
export async function copyTable(
  from: Database,
  into: Database,
  table: string,
  { read = {}, write = {}, map = row => row }: CopyTableOptions = {},
): Promise<void> {
  const target = new Set(await columnNames(into, table));
  const columns = (await columnNames(from, table)).filter(c => target.has(c));
  if (columns.length === 0) return;
  const select = await from.prepare(
    `SELECT rowid AS __evalution_rowid, ${columns
      .map(c => `${read[c] ?? quote(c)} AS ${quote(c)}`)
      .join(
        ", ",
      )} FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ${COPY_BATCH}`,
  );
  const insert = await into.prepare(
    `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns
      .map(c => write[c] ?? "?")
      .join(", ")}) ON CONFLICT DO NOTHING`,
  );
  let after = 0;
  for (;;) {
    const rows = (await select.all(after)) as Record<string, unknown>[];
    if (rows.length === 0) return;
    await into.transaction(async () => {
      for (const row of rows) {
        const mapped = map(row);
        await insert.run(...columns.map(c => mapped[c] ?? null));
      }
    })();
    after = Number(rows.at(-1)?.__evalution_rowid);
  }
}

/**
 * Copies tables a generic copy would get wrong, returning their names: a
 * dataset's fields, say, must be merged with the cloud's.
 */
export type MergeTables = (from: Database, into: Database) => Promise<string[]>;

/** Tables that aren't the database's own rows. */
const NOT_ROWS = /^(sqlite_|turso_|__turso)/;

/**
 * Copies every row of `from` into `into`, keeping `into`'s rows where both
 * have one. Leaves out what isn't rows: Turso's and SQLite's own tables,
 * the migrations ledger, and the sync links.
 */
export async function copyRows(
  from: Database,
  into: Database,
  merge?: MergeTables,
): Promise<void> {
  // Tables are copied one at a time, so a row may arrive before the one it
  // references.
  await into.exec("PRAGMA foreign_keys = OFF");
  const done = new Set([
    MIGRATIONS_TABLE,
    SYNC_LINKS_TABLE,
    ...((await merge?.(from, into)) ?? []),
  ]);
  const target = await tableNames(into);
  for (const table of await tableNames(from)) {
    if (NOT_ROWS.test(table) || done.has(table) || !target.has(table)) {
      continue;
    }
    await copyTable(from, into, table);
  }
}

/** What opening a database file for sync needs from its provider. */
export interface LocalDatabaseSync {
  database: DatabaseSync;
  /** Runs when a pull brings changes. */
  onPulled: () => void;
  /** Runs `during` with the provider's operations on the database paused. */
  pause: <T>(during: () => Promise<T>) => Promise<T>;
  /**
   * Opens the file again, as the provider first did. Called while paused,
   * after the old client was closed.
   */
  reopen: () => Promise<unknown>;
  /** Copies tables a generic copy would get wrong. */
  merge?: MergeTables;
  /** Removes the file: see {@link AttachOptions.onDeleted}. */
  onDeleted?: () => void;
  /**
   * A file that synced with an earlier cloud database of the same project
   * is replaced by the cloud's copy, not merged into it. For a dataset: that
   * database was deleted, and the dataset made again.
   */
  replaceSuperseded?: boolean;
}

/** Options for {@link openLocalDatabase}. */
export interface OpenLocalDatabaseOptions {
  path: string;
  /** Brings the schema up to date. */
  migrate: (client: Database) => Promise<void>;
  /**
   * The provider's sync, if it has one now. Asked again whenever sync needs
   * it, so a provider given sync after the file is open can start syncing it
   * with {@link startSyncing}, without reopening it.
   */
  sync?: () => LocalDatabaseSync | undefined;
}

/**
 * Opens a local database file, creating it if need be, and migrates it.
 * With sync, a file new to this machine starts as a copy of the cloud's,
 * and one that isn't linked to the cloud's database is adopted once the
 * cloud answers.
 */
export async function openLocalDatabase({
  path,
  migrate,
  sync = () => undefined,
}: OpenLocalDatabaseOptions): Promise<Database> {
  await recoverAdoption(path);
  const database = () => sync()?.database;
  const bootstrapping = database();
  const isNew = !(await exists(path));
  if (isNew) bootstrapping?.beginBootstrap();
  const client = await createLocalTursoClient({
    path,
    // Asked on every sync operation, so sync can start once the file is open.
    getCloudUrl: () => database()?.getCloudUrl() ?? null,
    getAuthToken: async () => {
      const current = database();
      if (!current) throw new Error("This database isn't synced.");
      return current.getAuthToken();
    },
    onBootstrapFailure: err => bootstrapping?.reportBootstrapFailure(err),
  });
  try {
    const copied = isNew ? bootstrapping?.endBootstrap() : undefined;
    if (copied) await recordSyncLink(client, copied);
    if ((await readSyncLinks(client)).length === 0) {
      await stopRecordingChanges(client);
    }
    await migrate(client);
    const current = sync();
    if (current) await startSyncing({ path, client, migrate, sync: current });
    return client;
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

/** Options for {@link startSyncing}. */
export interface StartSyncingOptions {
  path: string;
  /** The open file, from {@link openLocalDatabase}. */
  client: Database;
  migrate: (client: Database) => Promise<void>;
  sync: LocalDatabaseSync;
}

/**
 * Starts syncing a file {@link openLocalDatabase} opened: pulls if it holds
 * the cloud database's rows, and adopts it once the cloud answers if not.
 * Starting again with the same client does nothing.
 */
export async function startSyncing({
  path,
  client,
  migrate,
  sync,
}: StartSyncingOptions): Promise<void> {
  const links = await readSyncLinks(client);
  sync.database.attach(client, {
    links: links.map(link => link.syncId),
    onPulled: sync.onPulled,
    adopt: () => adopt(path, client, links, migrate, sync),
    ...(sync.onDeleted && { onDeleted: sync.onDeleted }),
  });
}

/** Swaps `path` for a copy of the cloud's database holding its rows too. */
async function adopt(
  path: string,
  client: Database,
  links: SyncLink[],
  migrate: (client: Database) => Promise<void>,
  sync: LocalDatabaseSync,
): Promise<void> {
  const credentials = sync.database.currentCredentials;
  if (!credentials) return;
  const copy = !(
    sync.replaceSuperseded &&
    links.some(link => link.projectId === credentials.projectId)
  );
  const adopting = path + ADOPTING;
  await removeDatabase(adopting);
  let into: Database | undefined;
  let committed = false;
  try {
    // A string URL: the copy must come from the cloud, or not be made.
    into = await connect({
      path: adopting,
      url: credentials.url,
      authToken: sync.database.getAuthToken,
      clientName: "evalution",
    });
    await migrate(into);
    await recordSyncLink(into, credentials);
    const copyInto = into;
    await sync.pause(async () => {
      try {
        if (copy) await copyRows(client, copyInto, sync.merge);
        await copyInto.close();
        await client.close();
        await writeSwapState(path, "replace");
        committed = true;
        await finishSwap(path);
      } finally {
        if (!committed) await client.close().catch(() => {});
        await sync.reopen();
      }
    });
  } finally {
    if (!committed) {
      await into?.close().catch(() => {});
      await removeDatabase(adopting);
    }
  }
}
