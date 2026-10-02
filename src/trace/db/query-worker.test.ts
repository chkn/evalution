// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real filesystem, deliberately: the worker opens the database by path, so an
 * in-memory database (or `MemoryFileProvider`) can't stand in for one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@tursodatabase/sync";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalTursoClient } from "./local-turso-client.ts";
import {
  MAX_RUNAWAY_QUERIES,
  runawayQueryCount,
  runQueryInWorker,
} from "./query-worker.ts";
import { SqlQueryError } from "./read-only-query.ts";

/** Ten million rows to count — slow enough to time out, quick enough to finish. */
const SLOW_QUERY =
  "WITH t(x) AS (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10)) " +
  "SELECT count(*) AS n FROM t a, t b, t c, t d, t e, t f, t g";

describe("runQueryInWorker", () => {
  let dir: string;
  let path: string;
  let client: Database;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "evalution-query-worker-"));
    path = join(dir, "q.db");
    client = await createLocalTursoClient({ path });
    await client.exec("CREATE TABLE items (id INTEGER, name TEXT)");
    await client.exec("INSERT INTO items VALUES (1, 'a'), (2, 'b'), (3, 'c')");
  });

  afterAll(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the rows the query selects, from the same file another connection writes", async () => {
    const result = await runQueryInWorker(
      path,
      "SELECT id, name FROM items ORDER BY id",
    );
    expect(result).toEqual({
      columns: ["id", "name"],
      rows: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
        { id: 3, name: "c" },
      ],
    });
  });

  it("caps the rows at maxRows and says so", async () => {
    const result = await runQueryInWorker(path, "SELECT id FROM items", {
      maxRows: 2,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("refuses writes, even ones that return rows", async () => {
    await expect(
      runQueryInWorker(path, "DELETE FROM items RETURNING id"),
    ).rejects.toBeInstanceOf(SqlQueryError);
    await expect(
      runQueryInWorker(path, "PRAGMA query_only = 0"),
    ).rejects.toThrow(/read-only/);
    const after = await runQueryInWorker(
      path,
      "SELECT count(*) AS n FROM items",
    );
    expect(after.rows).toEqual([{ n: 3 }]);
  });

  it("reports bad SQL as the caller's error", async () => {
    await expect(
      runQueryInWorker(path, "SELECT * FROM nowhere"),
    ).rejects.toBeInstanceOf(SqlQueryError);
  });

  it("stops waiting once the time limit passes, without blocking the event loop", async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    try {
      await expect(
        runQueryInWorker(path, SLOW_QUERY, { timeoutMs: 100 }),
      ).rejects.toThrow(/took longer than 0.1 s/);
    } finally {
      clearInterval(ticker);
    }
    // The main thread kept running timers while the query ran.
    expect(ticks).toBeGreaterThan(3);
  });

  it("refuses new queries while too many timed-out ones are still running, then recovers", async () => {
    // Wait out any query a previous test left running.
    await vi.waitFor(() => expect(runawayQueryCount()).toBe(0), {
      timeout: 10_000,
      interval: 50,
    });
    // Long enough for each to be inside the query when time runs out.
    await Promise.all(
      Array.from({ length: MAX_RUNAWAY_QUERIES }, () =>
        expect(
          runQueryInWorker(path, SLOW_QUERY, { timeoutMs: 300 }),
        ).rejects.toThrow(/took longer/),
      ),
    );
    await expect(runQueryInWorker(path, "SELECT 1 AS one")).rejects.toThrow(
      /still running/,
    );
    const recovered = await vi.waitFor(
      () => runQueryInWorker(path, "SELECT 1 AS one"),
      { timeout: 10_000, interval: 100 },
    );
    expect(recovered.rows).toEqual([{ one: 1 }]);
    await vi.waitFor(() => expect(runawayQueryCount()).toBe(0), {
      timeout: 10_000,
      interval: 50,
    });
  }, 30_000);
});
