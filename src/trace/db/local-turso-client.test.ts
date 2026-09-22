// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real filesystem, deliberately — the sync engine is a native SQLite build
 * that needs a real path (see `turso-drizzle-contract.test.ts`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
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
});
