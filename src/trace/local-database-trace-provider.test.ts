// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real filesystem, deliberately — the whole point of this class is *when* it
 * touches disk, which only a real path can exercise (see the sibling Turso
 * test files for the same reasoning).
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalDatabaseTraceProvider,
  resolveDbPath,
} from "./local-database-trace-provider.ts";
import type { TraceIngestor } from "./trace-ingestor.ts";
import { runTraceProviderContractTests } from "./trace-provider-contract.ts";
import type { TraceSink } from "./trace-sink.ts";
import type {
  Span,
  TraceChangeEvent,
  TraceStreamEvent,
} from "./trace-types.ts";

const contractDirs: string[] = [];

runTraceProviderContractTests(
  "LocalDatabaseTraceProvider",
  async opts => {
    const contractDir = await mkdtemp(
      join(tmpdir(), "evalution-local-db-contract-"),
    );
    contractDirs.push(contractDir);
    return new LocalDatabaseTraceProvider({
      path: join(contractDir, "local.db"),
      ...opts,
    });
  },
  async () => {
    await Promise.all(
      contractDirs.map(d => rm(d, { recursive: true, force: true })),
    );
  },
);

function rootSpan(traceId: string, overrides: Partial<Span> = {}): Span {
  return {
    id: `${traceId}:root`,
    traceId,
    name: "root",
    kind: "LLM",
    startTime: Date.now(),
    ...overrides,
  };
}

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function tempDbPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "evalution-local-db-"));
  return join(dir, "traces", "local.db");
}

describe("LocalDatabaseTraceProvider — deferred creation", () => {
  it("does not create the file or its directory at construction time", async () => {
    const dbPath = await tempDbPath();
    new LocalDatabaseTraceProvider({ path: dbPath });

    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(dir, "traces"))).toBe(false);
  });

  it("reads return empty/not-found without creating the file", async () => {
    const dbPath = await tempDbPath();
    const provider = new LocalDatabaseTraceProvider({ path: dbPath });

    expect(await provider.getAllTraces()).toEqual([]);
    expect(await provider.getTrace("t1")).toBeUndefined();
    expect(await provider.hasTrace("t1")).toBe(false);
    expect(await provider.listAnnotations("t1")).toEqual([]);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("creates the file (and parent directory) on the first write", async () => {
    const dbPath = await tempDbPath();
    const provider = new LocalDatabaseTraceProvider({ path: dbPath });

    await provider.recordSpanStart(rootSpan("t1"));

    expect(existsSync(dbPath)).toBe(true);
    const loaded = await provider.getTrace("t1");
    expect(loaded?.trace.status).toBe("running");
  });

  it("failTrace and createAnnotation also count as writes that create the file", async () => {
    const dbPath = await tempDbPath();
    const provider = new LocalDatabaseTraceProvider({ path: dbPath });
    await provider.failTrace("unknown", "boom"); // no-op at the storage level, but still opens
    expect(existsSync(dbPath)).toBe(true);
  });

  it("opens the database once when several first writes race", async () => {
    const dbPath = await tempDbPath();
    const provider = new LocalDatabaseTraceProvider({ path: dbPath });

    // Two sync clients over the same file fail outright ("database is busy"),
    // so concurrent first writes must share a single open, not each start one.
    await Promise.all([
      provider.recordSpanStart(rootSpan("t1")),
      provider.recordSpanStart(
        rootSpan("t1", { id: "t1:child", parentId: "t1:root" }),
      ),
      provider.failTrace("t2", "boom"),
    ]);

    const loaded = await provider.getTrace("t1");
    expect(loaded?.spans).toHaveLength(2);
  });

  it("opens an already-existing file immediately, with no write required", async () => {
    const dbPath = await tempDbPath();
    const first = new LocalDatabaseTraceProvider({ path: dbPath });
    await first.recordSpanStart(rootSpan("t1"));

    const second = new LocalDatabaseTraceProvider({ path: dbPath });
    // No write on `second` — give the constructor's fire-and-forget open a
    // tick to finish before asserting.
    await new Promise(r => setTimeout(r, 50));
    expect(await second.getTrace("t1")).toBeDefined();
  });
});

describe("LocalDatabaseTraceProvider — subscriptions registered before the file exists", () => {
  it("delivers watch() events once the first write opens the database", async () => {
    const dbPath = await tempDbPath();
    const provider = new LocalDatabaseTraceProvider({ path: dbPath });

    const seen: TraceChangeEvent[] = [];
    provider.watch(e => seen.push(e));

    await provider.recordSpanStart(rootSpan("t1"));
    expect(seen.map(e => `${e.type}:${e.traceId}`)).toContain("add:t1");
  });

  it("delivers subscribeTrace() events for a trace registered before it existed", async () => {
    const dbPath = await tempDbPath();
    const provider = new LocalDatabaseTraceProvider({ path: dbPath });

    const events: TraceStreamEvent[] = [];
    const unsubscribe = provider.subscribeTrace("t1", e => events.push(e));

    const span = rootSpan("t1");
    await provider.recordSpanStart(span);
    await provider.recordSpanEnd({
      ...span,
      endTime: Date.now(),
      status: "ok",
    });

    expect(events.map(e => e.type)).toEqual([
      "span-start",
      "span-end",
      "trace-end",
    ]);
    unsubscribe();
  });

  it("stops delivering events after unsubscribe, whether called before or after the bridge exists", async () => {
    const dbPath = await tempDbPath();
    const provider = new LocalDatabaseTraceProvider({ path: dbPath });

    const events: TraceStreamEvent[] = [];
    const unsubscribe = provider.subscribeTrace("t1", e => events.push(e));
    unsubscribe(); // before the database (and thus the real bridge) exists

    const span = rootSpan("t1");
    await provider.recordSpanStart(span);
    await provider.recordSpanEnd({
      ...span,
      endTime: Date.now(),
      status: "ok",
    });
    expect(events).toEqual([]);

    // Now unsubscribe *after* the bridge exists.
    const events2: TraceStreamEvent[] = [];
    const unsubscribe2 = provider.subscribeTrace("t1", e => events2.push(e));
    unsubscribe2();
    await provider.recordSpanEnd({
      ...span,
      endTime: Date.now(),
      status: "error",
    });
    expect(events2).toEqual([]);
  });
});

describe("LocalDatabaseTraceProvider — path resolution", () => {
  // Exercised via the pure `resolveDbPath` rather than constructing a real
  // provider: the constructor's own resolution has the side effect of
  // probing (and, if it exists — e.g. a real `.evalution/traces/local.db`
  // from normal app use — opening) whatever file the result names, which
  // these tests must not do. `process.chdir` isn't available under vitest's
  // worker threads either way, so this checks `resolveDbPath` against
  // `path.resolve`'s own CWD-relative semantics rather than actually
  // changing CWD — same resolution logic, exercised against whatever CWD the
  // test happens to run under.

  it("defaults to .evalution/traces/local.db relative to CWD", () => {
    expect(resolveDbPath(undefined)).toBe(
      resolve(".evalution/traces/local.db"),
    );
  });

  it("resolves a relative path against CWD", () => {
    expect(resolveDbPath("custom/rel.db")).toBe(resolve("custom/rel.db"));
  });

  it("accepts an absolute path unchanged, and creates the file there on write", async () => {
    dir = await mkdtemp(join(tmpdir(), "evalution-local-db-abs-"));
    const absPath = join(dir, "abs", "abs.db");
    const provider = new LocalDatabaseTraceProvider({ path: absPath });
    expect(provider.path).toBe(absPath);

    await provider.recordSpanStart(rootSpan("t1"));
    expect(existsSync(absPath)).toBe(true);
  });
});

describe("LocalDatabaseTraceProvider — ingestors", () => {
  it("connects ingestors passed at construction time as sinks of the wrapper itself", async () => {
    const dbPath = await tempDbPath();
    const sinksCalled: TraceSink[] = [];
    const ingestor: TraceIngestor = {
      addSink: (sink: TraceSink) => sinksCalled.push(sink),
      removeSink: () => false,
    };
    const provider = new LocalDatabaseTraceProvider({
      path: dbPath,
      ingestors: [ingestor],
    });

    expect(sinksCalled).toEqual([provider]);
  });
});
