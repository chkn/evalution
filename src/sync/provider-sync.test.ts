// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * How the local trace, eval and dataset providers drive their sync. The
 * sync itself is a stub; the databases are real files, since the sync engine
 * is a native SQLite build that needs a real path.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncDatabaseKey } from "@evalution/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDirectoryDatasetProvider } from "../dataset/local-directory-dataset-provider.ts";
import { LocalEvalProvider } from "../eval/local-eval-provider.ts";
import { LocalDatabaseTraceProvider } from "../trace/local-database-trace-provider.ts";
import type { DatabaseSync } from "./database-sync.ts";
import type { WorkspaceSync } from "./workspace-sync.ts";

/** One database's stubbed sync. */
interface StubDatabase {
  key: SyncDatabaseKey;
  schemaVersion: number;
  prepared: { create?: boolean }[];
  attached: boolean;
  /** How many times a database was attached: once per open file. */
  attaches: number;
  writes: number;
  url: string | null;
  /** What a pull does: by default, brings nothing. */
  onPull: () => Promise<boolean>;
  /** Simulates a pull bringing changes. */
  pulled: () => void;
  bootstrapFailures: number;
}

function stubSync(remoteDatasets: string[] = []) {
  const databases = new Map<string, StubDatabase>();
  const hooks: (() => Promise<void>)[] = [];
  const deleted: string[] = [];
  const workspace = {
    database(key: SyncDatabaseKey, schemaVersion: number) {
      const id = `${key.kind}/${key.provider}/${key.key ?? ""}`;
      let stub = databases.get(id);
      if (!stub) {
        const s: StubDatabase = {
          key,
          schemaVersion,
          prepared: [],
          attached: false,
          attaches: 0,
          writes: 0,
          url: null,
          onPull: async () => false,
          pulled: () => {},
          bootstrapFailures: 0,
        };
        stub = s;
        databases.set(id, s);
      }
      const s = stub;
      let attachedDb: unknown;
      return {
        async prepare(options: { create?: boolean } = {}) {
          s.prepared.push(options);
        },
        getCloudUrl: () => s.url,
        getAuthToken: async () => "token",
        reportBootstrapFailure: () => {
          s.bootstrapFailures++;
        },
        beginBootstrap() {},
        endBootstrap: () => undefined,
        get isAvailable() {
          return s.url !== null;
        },
        attach(db: unknown, { onPulled }: { onPulled: () => void }) {
          // As `DatabaseSync.attach`: the same database again does nothing.
          if (db === attachedDb) return;
          attachedDb = db;
          s.attached = true;
          s.attaches++;
          s.pulled = onPulled;
        },
        noteWrite() {
          s.writes++;
        },
        pull: () => s.onPull(),
      } as unknown as DatabaseSync;
    },
    onPull(hook: () => Promise<void>) {
      hooks.push(hook);
      return () => {};
    },
    async remoteDatasetIds(provider: string) {
      return provider === "local-datasets" ? remoteDatasets : [];
    },
    async deleteDataset(provider: string, id: string) {
      deleted.push(`${provider}/${id}`);
    },
  } as unknown as WorkspaceSync;
  return {
    workspace,
    /** `provider`, given the sync, as `setUpProject` does. */
    synced<T extends { _ecSetSync(sync: WorkspaceSync): void }>(provider: T) {
      provider._ecSetSync(workspace);
      return provider;
    },
    databases,
    deleted,
    db: (id: string) => {
      const found = databases.get(id);
      if (!found) throw new Error(`No sync for ${id}`);
      return found;
    },
    runPullHooks: async () => {
      for (const hook of hooks) await hook();
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evalution-provider-sync-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const span = (traceId: string) => ({
  id: `${traceId}:root`,
  traceId,
  name: "root",
  kind: "LLM" as const,
  startTime: 1,
});

describe("LocalDatabaseTraceProvider, syncing", () => {
  it("opens the database at once, after asking the cloud for its copy", async () => {
    const sync = stubSync();
    const path = join(dir, "traces", "local.db");
    const provider = sync.synced(new LocalDatabaseTraceProvider({ path }));

    await provider.getAllTraces();

    expect(existsSync(path)).toBe(true);
    const traces = sync.db("traces/local-db/");
    expect(traces.prepared).toHaveLength(1);
    expect(traces.attached).toBe(true);
    expect(traces.schemaVersion).toBeGreaterThan(0);
  });

  it("notes every write so it's pushed", async () => {
    const sync = stubSync();
    const provider = sync.synced(
      new LocalDatabaseTraceProvider({ path: join(dir, "local.db") }),
    );

    await provider.recordSpanStart(span("t1"));
    await provider.recordSpanEnd({ ...span("t1"), endTime: 2 });
    const note = await provider.createAnnotation({
      traceId: "t1",
      kind: "note",
      note: "hi",
      source: "user",
    });
    await provider.deleteAnnotation(note.id);
    await provider.deleteTrace("t1");

    expect(sync.db("traces/local-db/").writes).toBe(5);
  });

  it("says the list changed when a pull brings changes", async () => {
    const sync = stubSync();
    const provider = sync.synced(
      new LocalDatabaseTraceProvider({ path: join(dir, "local.db") }),
    );
    await provider.getAllTraces();
    const events: unknown[] = [];
    provider.watch(event => events.push(event));

    sync.db("traces/local-db/").pulled();

    expect(events).toEqual([{ type: "update", traceId: "" }]);
  });

  it("pulls once for a trace it doesn't have before saying it's missing", async () => {
    const sync = stubSync();
    const provider = sync.synced(
      new LocalDatabaseTraceProvider({ path: join(dir, "local.db") }),
    );
    await provider.getAllTraces();
    const traces = sync.db("traces/local-db/");
    const pull = vi.fn(async () => {
      // The other machine's trace arrives with the pull.
      await provider.recordSpanStart(span("shared"));
      return true;
    });
    traces.onPull = pull;

    const found = await provider.getTrace("shared");

    expect(pull).toHaveBeenCalledTimes(1);
    expect(found?.trace.id).toBe("shared");

    traces.onPull = vi.fn(async () => false);
    expect(await provider.getTrace("missing")).toBeUndefined();
    expect(traces.onPull).toHaveBeenCalledTimes(1);

    // A trace that's here needs no pull.
    await provider.getTrace("shared");
    expect(traces.onPull).toHaveBeenCalledTimes(1);
  });

  it("starts syncing a database it opened before it was given the sync", async () => {
    const path = join(dir, "local.db");
    const before = new LocalDatabaseTraceProvider({ path });
    await before.recordSpanStart(span("t1"));
    const sync = stubSync();
    const provider = new LocalDatabaseTraceProvider({ path });
    expect(await provider.hasTrace("t1")).toBe(true);

    provider._ecSetSync(sync.workspace);

    const traces = sync.db("traces/local-db/");
    await vi.waitFor(() => expect(traces.attached).toBe(true));
    expect(traces.attaches).toBe(1);
    expect(traces.prepared).toHaveLength(1);
    await provider.recordSpanStart(span("t2"));
    expect(traces.writes).toBe(1);
  });

  it("starts syncing once, given the sync while it's opening", async () => {
    const path = join(dir, "local.db");
    await new LocalDatabaseTraceProvider({ path }).recordSpanStart(span("t1"));
    const sync = stubSync();

    // Opens the existing file at once; the sync comes mid-open.
    const provider = new LocalDatabaseTraceProvider({ path });
    provider._ecSetSync(sync.workspace);
    await provider.getAllTraces();

    const traces = sync.db("traces/local-db/");
    await vi.waitFor(() => expect(traces.attached).toBe(true));
    expect(traces.attaches).toBe(1);
  });

  it("names its database by its id, so each provider syncs its own", async () => {
    const sync = stubSync();
    const a = sync.synced(
      new LocalDatabaseTraceProvider({ path: join(dir, "a.db"), id: "a" }),
    );
    const b = sync.synced(
      new LocalDatabaseTraceProvider({ path: join(dir, "b.db"), id: "b" }),
    );

    await a.recordSpanStart(span("t1"));
    await b.getAllTraces();

    expect(sync.db("traces/a/").writes).toBe(1);
    expect(sync.db("traces/b/").writes).toBe(0);
  });

  it("doesn't pull for a missing trace when not syncing", async () => {
    const provider = new LocalDatabaseTraceProvider({
      path: join(dir, "local.db"),
    });
    await provider.recordSpanStart(span("t1"));

    expect(await provider.getTrace("missing")).toBeUndefined();
  });
});

describe("LocalEvalProvider, syncing", () => {
  const def = {
    name: "Plans tasks",
    prompt: { id: "odin" },
    dataset: { providerId: "local-datasets", id: "tickets" },
    inputs: { functionInputs: {}, executeInputs: {} },
    checks: [],
  };

  it("opens the database at once, and notes writes", async () => {
    const sync = stubSync();
    const path = join(dir, "evals", "evals.db");
    const provider = sync.synced(new LocalEvalProvider({ path }));

    expect(await provider.listEvals()).toEqual([]);
    expect(existsSync(path)).toBe(true);
    const evals = sync.db("evals/local-evals/");
    expect(evals.attached).toBe(true);

    const created = await provider.createEval(def);
    await provider.updateEval(created.id, { name: "Renamed" });
    await provider.deleteEval(created.id);

    expect(evals.writes).toBe(3);
  });

  it("starts syncing a database it opened before it was given the sync", async () => {
    const path = join(dir, "evals.db");
    const provider = new LocalEvalProvider({ path });
    await provider.createEval(def);
    const sync = stubSync();

    provider._ecSetSync(sync.workspace);

    const evals = sync.db("evals/local-evals/");
    await vi.waitFor(() => expect(evals.attached).toBe(true));
    expect(evals.attaches).toBe(1);
    await provider.createEval(def);
    expect(evals.writes).toBe(1);
  });

  it("says the list changed when a pull brings changes", async () => {
    const sync = stubSync();
    const provider = sync.synced(
      new LocalEvalProvider({ path: join(dir, "evals.db") }),
    );
    await provider.listEvals();
    const events: unknown[] = [];
    provider.watch(event => events.push(event));

    sync.db("evals/local-evals/").pulled();

    expect(events).toEqual([{ type: "update", evalId: "" }]);
  });
});

describe("LocalDirectoryDatasetProvider, syncing", () => {
  it("asks the cloud to create a new dataset's copy, and notes its writes", async () => {
    const sync = stubSync();
    const provider = sync.synced(new LocalDirectoryDatasetProvider({ dir }));

    const dataset = await provider.createDataset({
      name: "Tickets",
      fields: [],
    });
    await provider.addRows(dataset.id, [{ cells: {} }]);

    const tickets = sync.db("dataset/local-datasets/tickets");
    expect(tickets.prepared).toEqual([{ create: true }]);
    expect(tickets.attached).toBe(true);
    expect(tickets.writes).toBeGreaterThanOrEqual(2);
    await provider.close();
  });

  it("starts syncing the datasets it opened before it was given the sync", async () => {
    const provider = new LocalDirectoryDatasetProvider({ dir });
    const dataset = await provider.createDataset({
      name: "Tickets",
      fields: [],
    });
    const sync = stubSync();

    provider._ecSetSync(sync.workspace);

    await vi.waitFor(() =>
      expect(sync.db(`dataset/local-datasets/${dataset.id}`).attached).toBe(
        true,
      ),
    );
    const tickets = sync.db(`dataset/local-datasets/${dataset.id}`);
    expect(tickets.attaches).toBe(1);
    await provider.addRows(dataset.id, [{ cells: {} }]);
    expect(tickets.writes).toBeGreaterThanOrEqual(1);
    await provider.close();
  });

  it("names its datasets by its id too", async () => {
    const sync = stubSync();
    const provider = sync.synced(
      new LocalDirectoryDatasetProvider({ dir, id: "shared" }),
    );

    await provider.createDataset({ name: "Tickets", fields: [] });

    expect(sync.db("dataset/shared/tickets").attached).toBe(true);
    await provider.close();
  });

  it("doesn't take the id of a dataset only the cloud has yet", async () => {
    const sync = stubSync(["tickets"]);
    const provider = sync.synced(new LocalDirectoryDatasetProvider({ dir }));

    const dataset = await provider.createDataset({
      name: "Tickets",
      fields: [],
    });

    expect(dataset.id).toBe("tickets-2");
    await provider.close();
  });

  it("says a dataset changed when a pull brings changes to it", async () => {
    const sync = stubSync();
    const provider = sync.synced(new LocalDirectoryDatasetProvider({ dir }));
    const dataset = await provider.createDataset({
      name: "Tickets",
      fields: [],
    });
    const events: unknown[] = [];
    provider.watch(event => events.push(event));

    sync.db(`dataset/local-datasets/${dataset.id}`).pulled();

    expect(events).toEqual([{ type: "update", datasetId: "tickets" }]);
    await provider.close();
  });

  it("deletes a dataset from the cloud too", async () => {
    const sync = stubSync();
    const provider = sync.synced(new LocalDirectoryDatasetProvider({ dir }));
    const dataset = await provider.createDataset({
      name: "Tickets",
      fields: [],
    });

    await provider.deleteDataset(dataset.id);

    expect(sync.deleted).toEqual(["local-datasets/tickets"]);
    expect(await provider.listDatasets()).toEqual([]);
  });

  it("fetches a dataset only the cloud has, when the sync pulls", async () => {
    const sync = stubSync(["from-elsewhere"]);
    const provider = sync.synced(new LocalDirectoryDatasetProvider({ dir }));
    const events: unknown[] = [];
    provider.watch(event => events.push(event));
    // Nothing listens there, so fetching its copy fails fast, and the
    // dataset opens empty until the next pull.
    sync.workspace.database(
      { kind: "dataset", provider: "local-datasets", key: "from-elsewhere" },
      1,
    );
    sync.db("dataset/local-datasets/from-elsewhere").url = "http://127.0.0.1:9";

    await sync.runPullHooks();

    expect(existsSync(join(dir, "from-elsewhere.db"))).toBe(true);
    expect(events).toEqual([{ type: "add", datasetId: "from-elsewhere" }]);
    expect(
      sync.db("dataset/local-datasets/from-elsewhere").bootstrapFailures,
    ).toBe(1);
    await provider.close();
  });

  it("leaves a cloud dataset alone while the cloud can't say where it is", async () => {
    const sync = stubSync(["from-elsewhere"]);
    const provider = sync.synced(new LocalDirectoryDatasetProvider({ dir }));

    await sync.runPullHooks();

    expect(existsSync(join(dir, "from-elsewhere.db"))).toBe(false);
    expect(await provider.listDatasets()).toEqual([]);
  });
});
