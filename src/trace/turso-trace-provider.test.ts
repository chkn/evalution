// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real filesystem, deliberately — same reasoning as
 * `src/trace/db/turso-drizzle-contract.test.ts`: the sync engine is a native
 * SQLite build that needs a real path.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalTursoClient } from "./db/local-turso-client.ts";
import { runMigrations } from "./db/migrate.ts";
import { runTraceProviderContractTests } from "./trace-provider-contract.ts";
import { TursoTraceProvider } from "./turso-trace-provider.ts";

const dirs: string[] = [];
const clients: Database[] = [];

async function makeMigratedClient(): Promise<Database> {
  const dir = await mkdtemp(join(tmpdir(), "evalution-turso-provider-"));
  dirs.push(dir);
  // The real bootstrap, not a bare `connect` — it's what turns on the
  // `foreign_keys` pragma that the schema's `ON DELETE CASCADE`s depend on.
  const client = await createLocalTursoClient({ path: join(dir, "trace.db") });
  clients.push(client);
  // `runMigrations` takes a Drizzle instance; build a throwaway one just to
  // apply DDL, mirroring what a real bootstrap does before ever constructing
  // the provider (which builds its own internally from the same client).
  await runMigrations(drizzle({ client }));
  return client;
}

runTraceProviderContractTests(
  "TursoTraceProvider",
  async opts => {
    const client = await makeMigratedClient();
    return new TursoTraceProvider({ client, ...opts });
  },
  async () => {
    await Promise.all(clients.map(c => c.close()));
    await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
  },
);

describe("TursoTraceProvider annotations", () => {
  let client: Database;

  afterEach(async () => {
    await client?.close();
  });

  it("creates, lists, and deletes annotations", async () => {
    client = await makeMigratedClient();
    const provider = new TursoTraceProvider({ client });
    await provider.recordSpanStart({
      id: "t1:root",
      traceId: "t1",
      name: "root",
      kind: "LLM",
      startTime: Date.now(),
    });

    const created = await provider.createAnnotation({
      traceId: "t1",
      kind: "issue",
      note: "looks wrong",
      source: "user",
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeGreaterThan(0);

    const spanAnnotation = await provider.createAnnotation({
      traceId: "t1",
      spanId: "t1:root",
      kind: "good",
      note: "nice",
      source: "claude-code",
    });

    const listed = await provider.listAnnotations("t1");
    expect(listed.map(a => a.id)).toEqual([created.id, spanAnnotation.id]);
    expect(listed[1]).toMatchObject({
      spanId: "t1:root",
      source: "claude-code",
    });

    await provider.deleteAnnotation(created.id);
    expect((await provider.listAnnotations("t1")).map(a => a.id)).toEqual([
      spanAnnotation.id,
    ]);
  });

  it("deleting a trace also deletes its spans and annotations, but no one else's", async () => {
    client = await makeMigratedClient();
    const provider = new TursoTraceProvider({ client });
    const start = (traceId: string) =>
      provider.recordSpanStart({
        id: `${traceId}:root`,
        traceId,
        name: "root",
        kind: "LLM",
        startTime: Date.now(),
      });
    await start("t1");
    await start("t2");
    for (const traceId of ["t1", "t2"])
      await provider.createAnnotation({
        traceId,
        kind: "note",
        note: "hi",
        source: "user",
      });

    await provider.deleteTrace("t1");

    // Asserted against the raw tables, not through the provider — its reads
    // are all scoped to a trace that no longer exists.
    const count = async (table: string, traceId: string) => {
      const stmt = await client.prepare(
        `select count(*) as n from ${table} where trace_id = ?`,
      );
      return ((await stmt.get(traceId)) as { n: number }).n;
    };
    expect(await count("spans", "t1")).toBe(0);
    expect(await count("annotations", "t1")).toBe(0);
    expect(await count("spans", "t2")).toBe(1);
    expect(await count("annotations", "t2")).toBe(1);
  });
});

describe("TursoTraceProvider row round-tripping", () => {
  let client: Database;

  afterEach(async () => {
    await client?.close();
  });

  it.each([
    ["text", "It's a cat."],
    ["text that looks like JSON", '{"not":"parsed"}'],
    ["an object", { team: { type: "choice", choice: "billing" } }],
    ["an array", [1, "two", { three: 3 }]],
    ["a number", 0.93],
  ])("round-trips %s as the output", async (_, output) => {
    client = await makeMigratedClient();
    const provider = new TursoTraceProvider({ client });
    const span = {
      id: "t1:root",
      traceId: "t1",
      name: "root",
      kind: "LLM" as const,
      startTime: 1,
    };
    await provider.recordSpanStart(span);
    await provider.recordSpanEnd({
      ...span,
      endTime: 2,
      status: "ok",
      llm: { input: { state: "hi", questions: {} }, output },
    });

    const loaded = await provider.getTrace("t1");
    expect(loaded?.spans[0].llm).toEqual({
      input: { state: "hi", questions: {} },
      output,
    });
  });

  it("round-trips LLM details, tool details, prompt reference, and multi-part content", async () => {
    client = await makeMigratedClient();
    const provider = new TursoTraceProvider({ client });

    await provider.recordSpanStart({
      id: "t1:root",
      traceId: "t1",
      name: "root",
      kind: "LLM",
      startTime: 1,
    });
    await provider.recordSpanEnd({
      id: "t1:root",
      traceId: "t1",
      name: "root",
      kind: "LLM",
      startTime: 1,
      endTime: 2,
      status: "ok",
      llm: {
        provider: "openai",
        model: "gpt-4o",
        finishReason: "stop",
        promptTokens: 5,
        completionTokens: 7,
        totalTokens: 12,
        cost: { prompt: 0.004, completion: 0.006 },
        input: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image",
                image: "https://x/y.png",
                mediaType: "image/png",
              },
            ],
          },
        ],
        output: "It's a cat.",
        modelParameters: { temperature: 0.5 },
      },
      prompt: { id: "mod#greet", providerId: "fs" },
    });

    await provider.recordSpanStart({
      id: "t1:tool",
      traceId: "t1",
      parentId: "t1:root",
      name: "tool",
      kind: "TOOL",
      startTime: 1,
    });
    await provider.recordSpanEnd({
      id: "t1:tool",
      traceId: "t1",
      parentId: "t1:root",
      name: "tool",
      kind: "TOOL",
      startTime: 1,
      endTime: 2,
      status: "ok",
      tool: { toolName: "search", input: { q: "cats" }, output: { count: 1 } },
    });

    const loaded = await provider.getTrace("t1");
    const root = loaded?.spans.find(s => s.id === "t1:root");
    expect(root?.llm).toEqual({
      provider: "openai",
      model: "gpt-4o",
      finishReason: "stop",
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
      cost: { prompt: 0.004, completion: 0.006 },
      input: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", image: "https://x/y.png", mediaType: "image/png" },
          ],
        },
      ],
      output: "It's a cat.",
      modelParameters: { temperature: 0.5 },
    });
    expect(root?.prompt).toEqual({ id: "mod#greet", providerId: "fs" });

    const tool = loaded?.spans.find(s => s.id === "t1:tool");
    expect(tool?.llm).toBeUndefined();
    expect(tool?.tool).toEqual({
      toolName: "search",
      input: { q: "cats" },
      output: { count: 1 },
    });
  });

  it("returns spanCount and newest-first ordering from getAllTraces", async () => {
    client = await makeMigratedClient();
    const provider = new TursoTraceProvider({ client });

    await provider.recordSpanStart({
      id: "a:root",
      traceId: "a",
      name: "a",
      kind: "LLM",
      startTime: 1,
    });
    await provider.recordSpanStart({
      id: "b:root",
      traceId: "b",
      name: "b",
      kind: "LLM",
      startTime: 2,
    });
    await provider.recordSpanStart({
      id: "b:child",
      traceId: "b",
      parentId: "b:root",
      name: "child",
      kind: "TOOL",
      startTime: 3,
    });

    const summaries = await provider.getAllTraces();
    expect(summaries.map(s => ({ id: s.id, spanCount: s.spanCount }))).toEqual([
      { id: "b", spanCount: 2 },
      { id: "a", spanCount: 1 },
    ]);
  });

  it("rolls up tokens, cost, model, and annotation counts across a trace's spans", async () => {
    client = await makeMigratedClient();
    const provider = new TursoTraceProvider({ client });

    // Trace "a": two LLM spans agreeing on model, one reporting totalTokens
    // directly and the other only prompt/completion — both should count.
    await provider.recordSpanStart({
      id: "a:root",
      traceId: "a",
      name: "root",
      kind: "LLM",
      startTime: 1,
    });
    await provider.recordSpanEnd({
      id: "a:root",
      traceId: "a",
      name: "root",
      kind: "LLM",
      startTime: 1,
      endTime: 2,
      status: "ok",
      llm: {
        model: "gpt-4o",
        totalTokens: 12,
        cost: { prompt: 0.004, completion: 0.006 },
      },
    });
    await provider.recordSpanStart({
      id: "a:child",
      traceId: "a",
      parentId: "a:root",
      name: "child",
      kind: "LLM",
      startTime: 1,
    });
    await provider.recordSpanEnd({
      id: "a:child",
      traceId: "a",
      parentId: "a:root",
      name: "child",
      kind: "LLM",
      startTime: 1,
      endTime: 2,
      status: "ok",
      llm: { model: "gpt-4o", promptTokens: 3, completionTokens: 4 },
    });
    await provider.createAnnotation({
      traceId: "a",
      kind: "issue",
      note: "bad tool call",
      source: "user",
    });
    await provider.createAnnotation({
      traceId: "a",
      kind: "issue",
      note: "also this",
      source: "user",
    });
    await provider.createAnnotation({
      traceId: "a",
      kind: "good",
      note: "nice recovery",
      source: "claude-code",
    });

    // Trace "b": two LLM spans disagreeing on model, neither reporting cost.
    await provider.recordSpanStart({
      id: "b:root",
      traceId: "b",
      name: "root",
      kind: "LLM",
      startTime: 3,
    });
    await provider.recordSpanEnd({
      id: "b:root",
      traceId: "b",
      name: "root",
      kind: "LLM",
      startTime: 3,
      endTime: 4,
      status: "ok",
      llm: { model: "gpt-4o", totalTokens: 5 },
    });
    await provider.recordSpanStart({
      id: "b:child",
      traceId: "b",
      parentId: "b:root",
      name: "child",
      kind: "LLM",
      startTime: 3,
    });
    await provider.recordSpanEnd({
      id: "b:child",
      traceId: "b",
      parentId: "b:root",
      name: "child",
      kind: "LLM",
      startTime: 3,
      endTime: 4,
      status: "ok",
      llm: { model: "claude-opus-4-5", totalTokens: 6 },
    });

    // Trace "c": a lone tool span — no LLM data, no annotations at all.
    await provider.recordSpanStart({
      id: "c:root",
      traceId: "c",
      name: "root",
      kind: "TOOL",
      startTime: 5,
    });

    const summaries = await provider.getAllTraces();
    const byId = Object.fromEntries(summaries.map(s => [s.id, s]));

    expect(byId.a).toMatchObject({
      totalTokens: 19, // 12 + (3 + 4)
      cost: 0.01, // 0.004 + 0.006
      model: "gpt-4o",
      annotationCounts: { issue: 2, good: 1, note: 0 },
    });
    // `toMatchObject` treats an absent key as a mismatch against an
    // explicit `undefined`, and these fields are omitted rather than
    // present-but-undefined (see the `...(x != null && {...})` spreads in
    // `getAllTraces`) — assert them individually instead.
    expect(byId.b.totalTokens).toBe(11); // 5 + 6
    expect(byId.b.cost).toBeUndefined();
    expect(byId.b.model).toBeUndefined(); // spans disagree
    expect(byId.b.annotationCounts).toEqual({ issue: 0, good: 0, note: 0 });

    expect(byId.c.totalTokens).toBeUndefined();
    expect(byId.c.cost).toBeUndefined();
    expect(byId.c.model).toBeUndefined();
    expect(byId.c.annotationCounts).toEqual({ issue: 0, good: 0, note: 0 });
  });
});

describe("TursoTraceProvider updateAnnotation", () => {
  let client: Database;

  afterEach(async () => {
    await client?.close();
  });

  it("changes kind and note, leaving the rest, and is undefined for an unknown id", async () => {
    client = await makeMigratedClient();
    const provider = new TursoTraceProvider({ client });
    await provider.recordSpanStart({
      id: "t:root",
      traceId: "t",
      name: "root",
      kind: "AGENT",
      startTime: 1,
    });
    const created = await provider.createAnnotation({
      traceId: "t",
      kind: "note",
      note: "first",
      source: "user",
    });

    const updated = await provider.updateAnnotation(created.id, {
      kind: "issue",
    });
    expect(updated).toEqual({ ...created, kind: "issue" });
    expect(
      await provider.updateAnnotation(created.id, { note: "second" }),
    ).toEqual({ ...created, kind: "issue", note: "second" });
    expect(await provider.updateAnnotation(created.id, {})).toEqual({
      ...created,
      kind: "issue",
      note: "second",
    });
    expect(await provider.listAnnotations("t")).toEqual([
      { ...created, kind: "issue", note: "second" },
    ]);
    expect(
      await provider.updateAnnotation("nope", { note: "x" }),
    ).toBeUndefined();
  });
});

describe("TursoTraceProvider query", () => {
  let client: Database;

  afterEach(async () => {
    await client?.close();
  });

  async function seeded(): Promise<TursoTraceProvider> {
    client = await makeMigratedClient();
    const provider = new TursoTraceProvider({ client });
    for (const [traceId, model, tokens] of [
      ["a", "gpt-4o", 10],
      ["b", "claude", 20],
      ["c", "claude", 30],
    ] as const) {
      await provider.recordSpanStart({
        id: `${traceId}:root`,
        traceId,
        name: `run ${traceId}`,
        kind: "LLM",
        startTime: tokens,
        llm: { model, totalTokens: tokens },
      });
    }
    return provider;
  }

  it("runs a SELECT against the documented tables", async () => {
    const provider = await seeded();
    expect(
      await provider.query(
        "SELECT llm_model AS model, sum(llm_total_tokens) AS tokens FROM spans GROUP BY llm_model ORDER BY model",
      ),
    ).toEqual({
      columns: ["model", "tokens"],
      rows: [
        { model: "claude", tokens: 50 },
        { model: "gpt-4o", tokens: 10 },
      ],
    });
    expect(
      await provider.query("SELECT id FROM traces ORDER BY id", { maxRows: 2 }),
    ).toEqual({
      columns: ["id"],
      rows: [{ id: "a" }, { id: "b" }],
      truncated: true,
    });
  });

  it("refuses writes, and keeps recording afterwards", async () => {
    const provider = await seeded();
    for (const sql of [
      "DELETE FROM traces",
      "UPDATE spans SET name = 'x'",
      "DELETE FROM traces RETURNING id",
      "PRAGMA query_only = 0",
      "DROP TABLE annotations",
    ]) {
      await expect(provider.query(sql), sql).rejects.toThrow();
    }
    await expect(provider.query("SELECT nope FROM traces")).rejects.toThrow();
    await expect(provider.query("  ")).rejects.toThrow("empty");
    expect(await provider.getAllTraces()).toHaveLength(3);
    // Read-only mode was switched back off: writes still land.
    await provider.createAnnotation({
      traceId: "a",
      kind: "good",
      note: "ok",
      source: "user",
    });
    expect(await provider.listAnnotations("a")).toHaveLength(1);
  });

  it("documents every column of every table in its query schema", async () => {
    const provider = await seeded();
    const schema = provider.getQuerySchema();
    for (const table of ["traces", "spans", "annotations"]) {
      const { rows } = await provider.query(
        `SELECT name FROM pragma_table_info('${table}')`,
      );
      expect(rows.length).toBeGreaterThan(0);
      const block = schema.slice(
        schema.indexOf(`CREATE TABLE ${table} (`),
        schema.indexOf(");", schema.indexOf(`CREATE TABLE ${table} (`)),
      );
      for (const { name } of rows) {
        expect(block, `${table}.${name}`).toMatch(
          new RegExp(`^\\s+${name}\\s`, "m"),
        );
      }
    }
  });
});
