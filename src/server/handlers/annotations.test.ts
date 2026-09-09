// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real filesystem, deliberately, for the "real provider" describe block —
 * same reasoning as `src/trace/turso-trace-provider.test.ts`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../trace/db/migrate.ts";
import { MemoryTraceProvider } from "../../trace/memory-trace-provider.ts";
import { TursoTraceProvider } from "../../trace/turso-trace-provider.ts";
import {
  handleCreateAnnotation,
  handleDeleteAnnotation,
  handleListAnnotations,
} from "./annotations.ts";

describe("annotation handlers against a provider with no annotation store", () => {
  it("all three respond 405", async () => {
    const provider = new MemoryTraceProvider();
    expect((await handleListAnnotations(provider, "t1")).status).toBe(405);
    expect(
      (
        await handleCreateAnnotation(provider, "t1", {
          kind: "note",
          note: "x",
        })
      ).status,
    ).toBe(405);
    expect((await handleDeleteAnnotation(provider, "t1", "a1")).status).toBe(
      405,
    );
  });
});

describe("annotation handlers against a real provider", () => {
  let dir: string;
  let client: Database;

  afterEach(async () => {
    await client?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function makeProvider(): Promise<TursoTraceProvider> {
    dir = await mkdtemp(join(tmpdir(), "evalution-annotations-"));
    client = await connect({ path: join(dir, "trace.db"), url: () => null });
    await runMigrations(drizzle({ client }));
    const provider = new TursoTraceProvider({ client });
    await provider.recordSpanStart({
      id: "t1:root",
      traceId: "t1",
      name: "root",
      kind: "LLM",
      startTime: Date.now(),
    });
    return provider;
  }

  it("creates an annotation, defaulting source to 'user', and emits an insert", async () => {
    const provider = await makeProvider();
    const events: unknown[] = [];
    provider.subscribeAnnotations("t1", e => events.push(e));

    const result = await handleCreateAnnotation(provider, "t1", {
      kind: "issue",
      note: "looks wrong",
    });

    expect(result.status).toBe(201);
    const annotation = result.body as any;
    expect(annotation.source).toBe("user");
    expect(annotation.traceId).toBe("t1");
    expect(events).toEqual([{ type: "annotation", op: "insert", annotation }]);
  });

  it("rejects a create request missing kind/note with 400", async () => {
    const provider = await makeProvider();
    const result = await handleCreateAnnotation(provider, "t1", {} as any);
    expect(result.status).toBe(400);
  });

  it("lists annotations for a trace", async () => {
    const provider = await makeProvider();
    await handleCreateAnnotation(provider, "t1", { kind: "note", note: "a" });
    await handleCreateAnnotation(provider, "t1", { kind: "good", note: "b" });

    const result = await handleListAnnotations(provider, "t1");
    expect(result.status).toBe(200);
    expect((result.body as any[]).map(a => a.note)).toEqual(["a", "b"]);
  });

  it("deletes an annotation and emits a delete event carrying the full annotation", async () => {
    const provider = await makeProvider();
    const created = await handleCreateAnnotation(provider, "t1", {
      kind: "note",
      note: "temp",
    });
    const annotation = created.body as any;

    const events: unknown[] = [];
    provider.subscribeAnnotations("t1", e => events.push(e));

    const result = await handleDeleteAnnotation(provider, "t1", annotation.id);
    expect(result.status).toBe(204);
    expect(events).toEqual([{ type: "annotation", op: "delete", annotation }]);
    expect(
      (await provider.listAnnotations("t1")).map((a: any) => a.id),
    ).not.toContain(annotation.id);
  });

  it("responds 404 deleting an id that doesn't exist", async () => {
    const provider = await makeProvider();
    const result = await handleDeleteAnnotation(provider, "t1", "nonexistent");
    expect(result.status).toBe(404);
  });
});
