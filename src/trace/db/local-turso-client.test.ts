// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real filesystem, deliberately — the sync engine is a native SQLite build
 * that needs a real path (see `turso-drizzle-contract.test.ts`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TursoTraceProvider } from "../turso-trace-provider.ts";
import { createLocalTursoClient } from "./local-turso-client.ts";
import { runMigrations } from "./migrate.ts";

describe("createLocalTursoClient", () => {
  let dir: string | undefined;
  let client: Database | undefined;

  afterEach(async () => {
    await client?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = client = undefined;
  });

  async function open() {
    dir = await mkdtemp(join(tmpdir(), "evalution-local-client-"));
    client = await createLocalTursoClient({ path: join(dir, "trace.db") });
    return client;
  }

  it("enables foreign key enforcement", async () => {
    const stmt = await (await open()).prepare("PRAGMA foreign_keys");
    expect(await stmt.get()).toEqual({ foreign_keys: 1 });
  });

  it("makes deleting a trace cascade to its annotations", async () => {
    // The schema's `annotations.trace_id` cascade (see `./schema.ts`) is only
    // enforced when the pragma above is on — `TursoTraceProvider.deleteTrace`
    // relies on it rather than deleting annotations itself.
    const db = await open();
    await runMigrations(drizzle({ client: db }));
    const provider = new TursoTraceProvider({ client: db });
    await provider.recordSpanStart({
      id: "t1:root",
      traceId: "t1",
      name: "root",
      kind: "LLM",
      startTime: 1,
    });
    await provider.createAnnotation({
      traceId: "t1",
      kind: "note",
      note: "hi",
      source: "user",
    });

    await provider.deleteTrace("t1");

    const stmt = await db.prepare("select count(*) as n from annotations");
    expect(await stmt.get()).toEqual({ n: 0 });
  });

  /** A stand-in for Turso that records requests and fails every one. */
  async function failingRemote() {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      requests,
      close: () => new Promise(resolve => server.close(resolve)),
    };
  }

  it("opens local-only when the cloud copy can't be fetched, and still syncs later", async () => {
    const remote = await failingRemote();
    try {
      dir = await mkdtemp(join(tmpdir(), "evalution-local-client-"));
      const onBootstrapFailure = vi.fn();

      client = await createLocalTursoClient({
        path: join(dir, "trace.db"),
        getCloudUrl: () => remote.url,
        getAuthToken: async () => "token",
        onBootstrapFailure,
      });

      // It tried to start from the cloud's copy, then opened without it.
      expect(remote.requests[0]).toMatch(/^POST \/pull-updates/);
      expect(onBootstrapFailure).toHaveBeenCalledTimes(1);
      await client.exec("CREATE TABLE t (v text)");

      // Sync stays on: the next push goes to the cloud.
      remote.requests.length = 0;
      await expect(client.push()).rejects.toThrow();
      expect(remote.requests.length).toBeGreaterThan(0);
    } finally {
      await remote.close();
    }
  });

  it("survives many upserts while it records changes for sync", async () => {
    // @tursodatabase/sync 0.8.3 corrupted the database here ("Corrupt
    // database: Invalid Blob value") by the second trace: every upsert into
    // a table whose changes are being captured, which deferred sync turns on.
    const db = await open();
    await runMigrations(drizzle({ client: db }));
    const provider = new TursoTraceProvider({ client: db });
    for (let t = 0; t < 10; t++) {
      const root = {
        id: `t${t}:root`,
        traceId: `t${t}`,
        name: "run",
        kind: "DEFAULT" as const,
        startTime: 1,
      };
      await provider.recordSpanStart(root);
      const llm = {
        ...root,
        id: `t${t}:llm`,
        parentId: root.id,
        kind: "LLM" as const,
      };
      await provider.recordSpanStart(llm);
      await provider.recordSpanEnd({ ...llm, endTime: 2, status: "ok" });
      await provider.recordSpanEnd({ ...root, endTime: 3, status: "ok" });
    }

    expect(await provider.getAllTraces()).toHaveLength(10);
    const cdc = await db.prepare("select count(*) as n from turso_cdc");
    expect((await cdc.get()).n).toBeGreaterThan(0);
  });
});
