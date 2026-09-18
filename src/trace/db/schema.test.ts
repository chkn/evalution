// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Guards the FK/cascade behavior described in `schema.ts`: `annotations.trace_id`
 * is a real `ON DELETE CASCADE` foreign key, while `spans.trace_id` is
 * deliberately unconstrained (a non-root span can arrive before its trace —
 * see `trace-sink.ts`) and instead relies on the `trg_spans_cascade_delete_trace`
 * trigger from the initial migration. Real filesystem, deliberately — same
 * reasoning as the sibling Turso test files: the sync engine needs a real path.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalTursoClient } from "./local-turso-client.ts";
import { runMigrations } from "./migrate.ts";
import { annotations, spans, traces } from "./schema.ts";

let dir: string;
let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalution-schema-"));
  const client = await createLocalTursoClient({
    path: join(dir, "trace.db"),
  });
  db = drizzle({ client });
  await runMigrations(db);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function insertTrace(id: string): Promise<void> {
  await db.insert(traces).values({
    id,
    name: "run",
    startTime: 1,
    status: "running",
  });
}

describe("foreign key enforcement", () => {
  it("rejects an annotation referencing a nonexistent trace", async () => {
    let error: unknown;
    try {
      await db.insert(annotations).values({
        id: "a1",
        traceId: "missing",
        kind: "note",
        note: "hi",
        source: "user",
        createdAt: 1,
      });
    } catch (err) {
      error = err;
    }

    // The FK violation surfaces as the driver-level `.cause`, not the outer
    // (query-text) Drizzle error message.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toMatchObject({
      message: expect.stringMatching(/FOREIGN KEY constraint failed/i),
    });
  });

  it("deleting a trace cascades to delete its annotations", async () => {
    await insertTrace("t1");
    await db.insert(annotations).values({
      id: "a1",
      traceId: "t1",
      kind: "note",
      note: "hi",
      source: "user",
      createdAt: 1,
    });

    await db.delete(traces).where(eq(traces.id, "t1"));

    expect(await db.select().from(annotations)).toHaveLength(0);
  });
});

describe("initial migration", () => {
  it("creates the span cascade trigger", async () => {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'trigger'`,
    );
    expect(rows.map(r => r.name)).toContain("trg_spans_cascade_delete_trace");
  });
});

describe("spans.trace_id", () => {
  it("allows a span to be inserted before its trace exists", async () => {
    // `recordSpanStart` (trace-sink.ts) persists a non-root span even when no
    // trace row exists yet for its traceId (out-of-order arrival) — a real FK
    // here would reject that insert.
    await db.insert(spans).values({
      id: "s1",
      traceId: "missing",
      parentId: "s0",
      name: "child",
      kind: "LLM",
      startTime: 1,
    });

    expect(await db.select().from(spans)).toHaveLength(1);
  });

  it("deleting a trace cascades to delete its spans via the trigger", async () => {
    await insertTrace("t1");
    await db.insert(spans).values({
      id: "s1",
      traceId: "t1",
      name: "root",
      kind: "LLM",
      startTime: 1,
    });

    await db.delete(traces).where(eq(traces.id, "t1"));

    expect(await db.select().from(spans)).toHaveLength(0);
  });

  it("leaves spans for other traces alone", async () => {
    await insertTrace("t1");
    await insertTrace("t2");
    await db.insert(spans).values([
      { id: "s1", traceId: "t1", name: "root", kind: "LLM", startTime: 1 },
      { id: "s2", traceId: "t2", name: "root", kind: "LLM", startTime: 1 },
    ]);

    await db.delete(traces).where(eq(traces.id, "t1"));

    const remaining = await db.select().from(spans);
    expect(remaining.map(s => s.id)).toEqual(["s2"]);
  });
});
