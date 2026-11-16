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
 * Only step 3 can't simply be started over. A marker file says it has
 * begun, so opening the file finishes it after a crash.
 */

import { constants } from "node:fs";
import { copyFile, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * Files Turso keeps beside a database. `-wal-revert` is the sync engine's,
 * written while a pull sets local changes aside. `-shm` is SQLite's own, in
 * case another build opened it.
 */
const SIDECARS = ["-wal", "-wal-revert", "-shm", "-info", "-changes"];

const ADOPTING = ".adopting";
/** Says the adopted copy is taking the file's place. */
const SWAPPING = ".adopted";

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

/** A database file and the files Turso keeps beside it. */
export function filesOf(path: string): string[] {
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

/**
 * Puts the adopted copy in the file's place, once the {@link SWAPPING}
 * marker is down: each of the file's files is removed, and the copy's put
 * there if it has one. The copy's files outlive the marker, so a crash
 * before it's removed leaves everything to run this again from, and one
 * after leaves a finished swap.
 *
 * Copied, not renamed: `@tursodatabase/sync` 0.7 remembers a closed
 * database by its file, not its path, until it's garbage collected, so a
 * renamed file reopened in the same process is taken for the old path's,
 * and fails to open. A copy into a path just emptied is a new file. (A
 * clone, where the file system can, so it's instant.) The closed database
 * also keeps its files open until then, so their inodes can't be reused
 * meanwhile.
 */
async function finishSwap(path: string): Promise<void> {
  const adopted = filesOf(path + ADOPTING);
  for (const [i, target] of filesOf(path).entries()) {
    const source = adopted[i] as string;
    await rm(target, { force: true });
    if (await exists(source)) {
      await copyFile(source, target, constants.COPYFILE_FICLONE);
    }
  }
  await rm(path + SWAPPING, { force: true });
  await removeDatabase(path + ADOPTING);
}

/**
 * Finishes a swap a crash interrupted, or discards an adoption that hadn't
 * got that far: it starts over once the file is open.
 */
export async function recoverAdoption(path: string): Promise<void> {
  if (await exists(path + SWAPPING)) await finishSwap(path);
  else await removeDatabase(path + ADOPTING);
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
 * dataset's fields, say, must be merged with the cloud's. Runs before the
 * other tables are copied, so its tables can't reference theirs.
 */
export type MergeTables = (from: Database, into: Database) => Promise<string[]>;

/** Tables that aren't the database's own rows. */
const NOT_ROWS = /^(sqlite_|turso_|__turso)/;

/**
 * `tables`, each after the ones it references. Tables that reference each
 * other in a cycle keep the order they came in.
 */
async function referencedFirst(
  db: Database,
  tables: string[],
): Promise<string[]> {
  const included = new Set(tables);
  const ordered = new Set<string>();
  const visiting = new Set<string>();
  const visit = async (table: string): Promise<void> => {
    if (!included.has(table) || ordered.has(table) || visiting.has(table)) {
      return;
    }
    visiting.add(table);
    const references = await all(
      db,
      `SELECT "table" FROM pragma_foreign_key_list(?)`,
      table,
    );
    for (const { table: referenced } of references) {
      await visit(String(referenced));
    }
    ordered.add(table);
  };
  for (const table of tables) await visit(table);
  return [...ordered];
}

/**
 * Copies every row of `from` into `into`, keeping `into`'s rows where both
 * have one. Leaves out what isn't rows: Turso's and SQLite's own tables,
 * the migrations ledger, and the sync links.
 *
 * Sync pushes the rows in the order they're written here, and the cloud
 * checks each one's foreign keys as it arrives. A row it rejects is lost:
 * the rest of the push lands, and the next pull drops the row here too. So
 * each table is copied after the ones it references, with foreign keys
 * checked as the cloud checks them: a row it would reject fails the
 * adoption instead, before the file is touched.
 */
export async function copyRows(
  from: Database,
  into: Database,
  merge?: MergeTables,
): Promise<void> {
  await into.exec("PRAGMA foreign_keys = ON");
  const done = new Set([
    MIGRATIONS_TABLE,
    SYNC_LINKS_TABLE,
    ...((await merge?.(from, into)) ?? []),
  ]);
  const target = await tableNames(into);
  const tables = [...(await tableNames(from))].filter(
    table => !NOT_ROWS.test(table) && !done.has(table) && target.has(table),
  );
  for (const table of await referencedFirst(into, tables)) {
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
  // A file new to this machine starts as a copy of the cloud's database, if
  // the cloud has said where it is: its URL is handed over while connecting.
  let bootstrap = (await exists(path))
    ? undefined
    : database()?.currentCredentials;
  const client = await createLocalTursoClient({
    path,
    // Asked on every sync operation, so sync can start once the file is open.
    getCloudUrl: () => bootstrap?.url ?? database()?.getCloudUrl() ?? null,
    getAuthToken: async () => {
      const current = database();
      if (!current) throw new Error("This database isn't synced.");
      return current.getAuthToken();
    },
    onBootstrapFailure: err => {
      // It's made empty instead, and adopted once the cloud answers.
      bootstrap = undefined;
      database()?.reportBootstrapFailure(err);
    },
  });
  const copied = bootstrap;
  bootstrap = undefined;
  try {
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
  let swapping = false;
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
      if (copy) await copyRows(client, copyInto, sync.merge);
      await copyInto.close();
      try {
        await client.close();
        await writeFile(path + SWAPPING, "");
        swapping = true;
        await finishSwap(path);
      } finally {
        // The old client is gone. Opening the file again finishes a swap
        // that failed partway.
        await sync.reopen();
      }
    });
  } finally {
    if (!swapping) {
      await into?.close().catch(() => {});
      await removeDatabase(adopting);
    }
  }
}
