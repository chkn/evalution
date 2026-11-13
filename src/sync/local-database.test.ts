// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real files, deliberately: the sync engine is a native SQLite build that
 * needs a real path. Adoption itself needs a cloud copy to start from, so
 * it's tested end to end, in `sync-server.test.ts`.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Database } from "@tursodatabase/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalTursoClient } from "../trace/db/local-turso-client.ts";
import { MIGRATIONS_TABLE } from "../trace/db/migrate.ts";
import {
  copyRows,
  openLocalDatabase,
  readSyncLinks,
  recordSyncLink,
  recoverAdoption,
  SYNC_LINKS_TABLE,
} from "./local-database.ts";

let dir: string;
const open: Database[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalution-local-database-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map(db => db.close().catch(() => {})));
  await rm(dir, { recursive: true, force: true });
});

const track = (db: Database) => {
  open.push(db);
  return db;
};

async function all(db: Database, sql: string) {
  return (await (await db.prepare(sql)).all()) as Record<string, unknown>[];
}

/** How many changes `db` has recorded for sync. */
async function recorded(db: Database): Promise<number> {
  const [table] = await all(
    db,
    "SELECT 1 FROM sqlite_schema WHERE name = 'turso_cdc'",
  );
  if (!table) return 0;
  return Number((await all(db, "SELECT count(*) AS n FROM turso_cdc"))[0]?.n);
}

const makeTable = (db: Database) =>
  db.exec("CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, v TEXT)");

describe("openLocalDatabase", () => {
  it("doesn't record changes in a file that has never synced", async () => {
    const db = track(
      await openLocalDatabase({ path: join(dir, "a.db"), migrate: makeTable }),
    );

    await db.exec("INSERT INTO t VALUES ('a', 'x')");

    expect(await recorded(db)).toBe(0);
  });

  it("drops the changes an earlier evalution recorded in a file that never synced", async () => {
    const path = join(dir, "a.db");
    const before = await createLocalTursoClient({ path });
    await makeTable(before);
    await before.exec("INSERT INTO t VALUES ('a', 'x')");
    expect(await recorded(before)).toBeGreaterThan(0);
    await before.close();

    const db = track(await openLocalDatabase({ path, migrate: makeTable }));

    expect(await recorded(db)).toBe(0);
    expect(await all(db, "SELECT id FROM t")).toEqual([{ id: "a" }]);
  });

  it("keeps recording changes in a file that has synced, though the project isn't linked now", async () => {
    // Its changes are pushed when it's linked again.
    const path = join(dir, "a.db");
    const before = await createLocalTursoClient({ path });
    await recordSyncLink(before, { syncId: "db-1", projectId: "prj_1" });
    await before.close();

    const db = track(await openLocalDatabase({ path, migrate: makeTable }));
    await db.exec("INSERT INTO t VALUES ('a', 'x')");

    expect(await recorded(db)).toBeGreaterThan(0);
  });
});

describe("sync links", () => {
  it("are recorded once each", async () => {
    const db = track(await connect({ path: join(dir, "a.db") }));
    expect(await readSyncLinks(db)).toEqual([]);

    await recordSyncLink(db, { syncId: "db-1", projectId: "prj_1" });
    await recordSyncLink(db, { syncId: "db-1", projectId: "prj_1" });
    await recordSyncLink(db, { syncId: "db-2", projectId: "prj_2" });

    expect(await readSyncLinks(db)).toEqual([
      { syncId: "db-1", projectId: "prj_1" },
      { syncId: "db-2", projectId: "prj_2" },
    ]);
  });
});

describe("copyRows", () => {
  async function pair() {
    const from = track(await connect({ path: join(dir, "from.db") }));
    const into = track(await connect({ path: join(dir, "into.db") }));
    return { from, into };
  }

  it("copies every row, keeping the target's where both have one", async () => {
    const { from, into } = await pair();
    await makeTable(from);
    await makeTable(into);
    await from.exec("INSERT INTO t VALUES ('a', 'local'), ('b', 'local')");
    await into.exec("INSERT INTO t VALUES ('b', 'cloud')");

    await copyRows(from, into);

    expect(await all(into, "SELECT id, v FROM t ORDER BY id")).toEqual([
      { id: "a", v: "local" },
      { id: "b", v: "cloud" },
    ]);
  });

  it("copies the columns both have", async () => {
    const { from, into } = await pair();
    await from.exec("CREATE TABLE t (id TEXT PRIMARY KEY, gone TEXT)");
    await into.exec("CREATE TABLE t (id TEXT PRIMARY KEY, added TEXT)");
    await from.exec("INSERT INTO t VALUES ('a', 'x')");

    await copyRows(from, into);

    expect(await all(into, "SELECT * FROM t")).toEqual([
      { id: "a", added: null },
    ]);
  });

  it("copies more rows than it reads at once, with JSONB intact", async () => {
    const { from, into } = await pair();
    for (const db of [from, into]) {
      await db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, cells BLOB)");
    }
    await from.transaction(async () => {
      const insert = await from.prepare("INSERT INTO t VALUES (?, jsonb(?))");
      for (let i = 0; i < 1234; i++) {
        await insert.run(`r${i}`, JSON.stringify({ n: i }));
      }
    })();

    await copyRows(from, into);

    expect(await all(into, "SELECT count(*) AS n FROM t")).toEqual([
      { n: 1234 },
    ]);
    expect(
      await all(into, "SELECT json(cells) AS cells FROM t WHERE id = 'r1233'"),
    ).toEqual([{ cells: '{"n":1233}' }]);
  });

  it("leaves out the migrations ledger, the sync links, and Turso's own tables", async () => {
    const { from, into } = await pair();
    for (const db of [from, into]) {
      await db.exec(
        `CREATE TABLE ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY, hash TEXT)`,
      );
    }
    await from.exec(`INSERT INTO ${MIGRATIONS_TABLE} VALUES (1, 'local')`);
    await recordSyncLink(from, { syncId: "db-0", projectId: "prj_0" });
    await into.exec(
      `CREATE TABLE ${SYNC_LINKS_TABLE} (sync_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, linked_at INTEGER NOT NULL)`,
    );

    await copyRows(from, into);

    expect(await all(into, `SELECT * FROM ${MIGRATIONS_TABLE}`)).toEqual([]);
    expect(await readSyncLinks(into)).toEqual([]);
  });

  it("leaves the tables a merge copied to it", async () => {
    const { from, into } = await pair();
    await makeTable(from);
    await makeTable(into);
    await from.exec("INSERT INTO t VALUES ('a', 'x')");

    await copyRows(from, into, async () => ["t"]);

    expect(await all(into, "SELECT * FROM t")).toEqual([]);
  });
});

describe("recoverAdoption", () => {
  // The swap only moves files, so plain files stand in for databases.
  const file = (name: string) => join(dir, name);
  const write = (name: string, text: string) => writeFile(file(name), text);
  const read = (name: string) => readFile(file(name), "utf8");

  it("discards an adoption that hadn't reached the swap", async () => {
    await write("a.db", "old");
    await write("a.db.adopting", "new");
    await write("a.db.adopting-wal", "new wal");

    await recoverAdoption(file("a.db"));

    expect(await read("a.db")).toBe("old");
    expect(existsSync(file("a.db.adopting"))).toBe(false);
    expect(existsSync(file("a.db.adopting-wal"))).toBe(false);
  });

  it("finishes a swap that had begun removing the file", async () => {
    await write("a.db-wal", "old wal");
    await write("a.db.adopting", "new");
    await write("a.db.adopting-info", "new info");
    await write("a.db.adopted", "replace");

    await recoverAdoption(file("a.db"));

    expect(await read("a.db")).toBe("new");
    expect(await read("a.db-info")).toBe("new info");
    expect(existsSync(file("a.db-wal"))).toBe(false);
    expect(existsSync(file("a.db.adopting"))).toBe(false);
    expect(existsSync(file("a.db.adopted"))).toBe(false);
  });

  it("finishes a swap that had begun putting the copy in place", async () => {
    await write("a.db", "new");
    await write("a.db.adopting-info", "new info");
    await write("a.db.adopted", "place");

    await recoverAdoption(file("a.db"));

    expect(await read("a.db")).toBe("new");
    expect(await read("a.db-info")).toBe("new info");
    expect(existsSync(file("a.db.adopting-info"))).toBe(false);
    expect(existsSync(file("a.db.adopted"))).toBe(false);
  });

  it("does nothing to a file no adoption touched", async () => {
    await write("a.db", "old");

    await recoverAdoption(file("a.db"));

    expect(await read("a.db")).toBe("old");
  });
});
