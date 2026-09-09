// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Contract tests for the persistence stack `TursoTraceProvider` will be built
 * on: Drizzle's `tursodatabase-sync` driver over a `@tursodatabase/sync`
 * client (see `specs/trace-workshopping.md` §B).
 *
 * These started life as a throwaway spike. They are kept as tests because the
 * stack is pinned to a Drizzle **pre-release** (`1.0.0-rc.4`) — the
 * `tursodatabase-sync` driver does not exist in the `latest` tag at all — so
 * every primitive the provider depends on needs a guard that fails loudly on a
 * dependency bump rather than silently at runtime.
 *
 * Real filesystem, deliberately: `MemoryFileProvider` is not an option here.
 * The sync engine is a native SQLite build that opens a real path and writes a
 * family of sidecar files (`-info`, `-wal`, CDC tables); a temp dir is the only
 * way to exercise it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Database } from "@tursodatabase/sync";
import { eq, sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { migrateAsync } from "drizzle-orm/sqlite-core/async/session";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A representative slice of the schema planned in §B.1 — enough to exercise
 * every primitive the provider needs (text PK, nullable end time, promoted LLM
 * columns, JSON blob column, secondary index). Not the real schema; that lands
 * with `src/trace/db/schema.ts`.
 */
const traces = sqliteTable(
  "traces",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id"),
    name: text("name").notNull(),
    startTime: real("start_time").notNull(),
    endTime: real("end_time"),
    status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
    attributes: text("attributes"),
  },
  t => [index("idx_traces_start").on(t.startTime)],
);

const spans = sqliteTable(
  "spans",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    startTime: real("start_time").notNull(),
    endTime: real("end_time"),
    llmModel: text("llm_model"),
    llmPromptTokens: integer("llm_prompt_tokens"),
    attributes: text("attributes"),
  },
  t => [index("idx_spans_trace").on(t.traceId)],
);

const SCHEMA_DDL = `
  CREATE TABLE traces (
    id text PRIMARY KEY, provider_id text, name text NOT NULL,
    start_time real NOT NULL, end_time real, status text NOT NULL, attributes text
  );
  CREATE INDEX idx_traces_start ON traces (start_time);
  CREATE TABLE spans (
    id text PRIMARY KEY, trace_id text NOT NULL, parent_id text, name text NOT NULL,
    kind text NOT NULL, start_time real NOT NULL, end_time real,
    llm_model text, llm_prompt_tokens integer, attributes text
  );
  CREATE INDEX idx_spans_trace ON spans (trace_id);
`;

let dir: string;
let client: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalution-turso-"));
  // `url` as a function returning null is what keeps this local-only: the SDK
  // derives its internal `bootstrapIfEmpty` from it, so nothing touches the
  // network. See the deferred-sync tests for that contract.
  client = await connect({ path: join(dir, "trace.db"), url: () => null });
});

afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Drizzle over @tursodatabase/sync", () => {
  it("accepts a sync client and round-trips a typed insert/select", async () => {
    const db = drizzle({ client });
    await client.exec(SCHEMA_DDL);

    await db.insert(traces).values({
      id: "t1",
      providerId: "turso",
      name: "run",
      startTime: 1,
      status: "running",
      attributes: '{"a":1}',
    });

    const [row] = await db.select().from(traces).where(eq(traces.id, "t1"));
    expect(row).toMatchObject({
      id: "t1",
      providerId: "turso",
      name: "run",
      status: "running",
      attributes: '{"a":1}',
    });
    // A still-running trace leaves `end_time` NULL rather than defaulting.
    expect(row?.endTime).toBeNull();
  });

  it("supports the upsert `addOrUpdateSpan` merges with", async () => {
    const db = drizzle({ client });
    await client.exec(SCHEMA_DDL);

    // The provider sees each span twice: a start snapshot, then an end
    // snapshot carrying the fields only known on completion.
    await db.insert(spans).values({
      id: "s1",
      traceId: "t1",
      name: "gen",
      kind: "LLM",
      startTime: 1,
    });

    await db
      .insert(spans)
      .values({
        id: "s1",
        traceId: "t1",
        name: "gen",
        kind: "LLM",
        startTime: 1,
        endTime: 9,
        llmModel: "claude-opus-5",
        llmPromptTokens: 42,
      })
      .onConflictDoUpdate({
        target: spans.id,
        set: {
          endTime: sql`excluded.end_time`,
          llmModel: sql`excluded.llm_model`,
          llmPromptTokens: sql`excluded.llm_prompt_tokens`,
        },
      });

    const all = await db.select().from(spans);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: "s1",
      startTime: 1,
      endTime: 9,
      llmModel: "claude-opus-5",
      llmPromptTokens: 42,
    });
  });

  it("rolls back a failed transaction and commits a successful one", async () => {
    const db = drizzle({ client });
    await client.exec(SCHEMA_DDL);

    await expect(
      db.transaction(async tx => {
        await tx.insert(spans).values({
          id: "s1",
          traceId: "t1",
          name: "a",
          kind: "TOOL",
          startTime: 1,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.select().from(spans)).toHaveLength(0);

    await db.transaction(async tx => {
      await tx.insert(spans).values({
        id: "s2",
        traceId: "t1",
        name: "b",
        kind: "TOOL",
        startTime: 2,
      });
    });
    expect(await db.select().from(spans)).toHaveLength(1);
  });
});

describe("fs-free migrations", () => {
  // §B.4: Drizzle's own `migrate()` reads the migrations folder with `node:fs`,
  // which is unusable under Workers. `migrateAsync` takes a pre-read array, so
  // migrations can be bundled into a TS constant at build time while still
  // reusing Drizzle's ledger table and transactional apply. These tests pin
  // that the public import path and the array shape keep working.
  const migrationsTable = "__evalution_migrations";

  const bundled = [
    {
      name: "0000_init",
      hash: "h0",
      folderMillis: 1,
      bps: false,
      sql: ["CREATE TABLE traces (id text PRIMARY KEY, name text NOT NULL)"],
    },
    {
      name: "0001_spans",
      hash: "h1",
      folderMillis: 2,
      bps: false,
      sql: [
        "CREATE TABLE spans (id text PRIMARY KEY, trace_id text NOT NULL)",
        "CREATE INDEX idx_spans_trace ON spans (trace_id)",
      ],
    },
  ];

  async function tableNames(): Promise<string[]> {
    const stmt = await client.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const rows = (await stmt.all()) as { name: string }[];
    // Ignore the sync engine's own CDC bookkeeping tables.
    return rows
      .map(r => r.name)
      .filter(
        n =>
          !n.startsWith("turso_") &&
          !n.startsWith("__turso") &&
          !n.startsWith("sqlite_"),
      );
  }

  async function ledger(): Promise<string[]> {
    const stmt = await client.prepare(
      `SELECT name FROM ${migrationsTable} ORDER BY id`,
    );
    return ((await stmt.all()) as { name: string }[]).map(r => r.name);
  }

  it("applies bundled migrations without touching the filesystem", async () => {
    const db = drizzle({ client });
    await migrateAsync(bundled, db, { migrationsTable });

    expect(await tableNames()).toEqual([migrationsTable, "spans", "traces"]);
    expect(await ledger()).toEqual(["0000_init", "0001_spans"]);
  });

  it("is idempotent when re-run against an up-to-date database", async () => {
    const db = drizzle({ client });
    await migrateAsync(bundled, db, { migrationsTable });
    await migrateAsync(bundled, db, { migrationsTable });

    // Two rows, not four — re-running must not re-apply.
    expect(await ledger()).toEqual(["0000_init", "0001_spans"]);
  });

  it("forward-migrates a database created by an earlier version", async () => {
    const db = drizzle({ client });
    await migrateAsync(bundled, db, { migrationsTable });

    // The upgrade path from §B.4: a user on an older release opens a DB that a
    // newer release has extra migrations for.
    const next = [
      ...bundled,
      {
        name: "0002_annotations",
        hash: "h2",
        folderMillis: 3,
        bps: false,
        sql: [
          "CREATE TABLE annotations (id text PRIMARY KEY, trace_id text NOT NULL)",
        ],
      },
    ];
    await migrateAsync(next, db, { migrationsTable });

    expect(await tableNames()).toContain("annotations");
    expect(await ledger()).toEqual([
      "0000_init",
      "0001_spans",
      "0002_annotations",
    ]);
  });
});
