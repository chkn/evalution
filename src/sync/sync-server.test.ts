// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Workspace sync end to end: two "machines" — two project directories, each
 * with its own default providers and `WorkspaceSync` — syncing through a real
 * Turso sync server (`tursodb --sync-server`), which speaks the same protocol
 * as Turso Cloud. Only Evalution Cloud is faked: it hands out the server's
 * URLs, as the real one hands out Turso Cloud's.
 *
 * Skipped unless `tursodb` is installed: `TURSODB` names it, or it's at
 * `~/.turso/tursodb` or on the `PATH`.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvalutionApiError,
  type SyncDatabaseKey,
  type SyncDatabaseRequest,
} from "@evalution/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { def, text } from "../dataset/dataset-provider-contract.ts";
import { LocalDirectoryDatasetProvider } from "../dataset/local-directory-dataset-provider.ts";
import { LocalEvalProvider } from "../eval/local-eval-provider.ts";
import { LocalDatabaseTraceProvider } from "../trace/local-database-trace-provider.ts";
import { type WorkspaceCloud, WorkspaceSync } from "./workspace-sync.ts";

function findTursodb(): string | undefined {
  if (process.env.TURSODB) return process.env.TURSODB;
  const home = join(homedir(), ".turso", "tursodb");
  if (existsSync(home)) return home;
  const found = spawnSync("which", ["tursodb"], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : undefined;
}

const tursodb = findTursodb();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Waits for the sync server to answer. */
async function waitForServer(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${url}/db/ready/pull-updates`, { method: "POST" });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error("tursodb --sync-server didn't start");
}

/**
 * Turns on foreign keys for one of the sync server's databases, as Turso
 * Cloud has them: a push that inserts a row before the one it references
 * fails there. The server keeps one connection per database, so the pragma
 * holds for the pushes that follow.
 */
async function enforceForeignKeys(databaseUrl: string): Promise<void> {
  const response = await fetch(`${databaseUrl}/v2/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baton: null,
      requests: [
        { type: "execute", stmt: { sql: "PRAGMA foreign_keys = ON" } },
      ],
    }),
  });
  if (!response.ok) throw new Error(await response.text());
}

/**
 * Evalution Cloud, for one project: each synced database is one of the
 * sync server's, and deleted datasets are remembered as the registry does.
 */
function fakeCloud(serverUrl: string, project: string): WorkspaceCloud {
  const live = new Map<string, Required<SyncDatabaseKey>>();
  const enforced = new Set<string>();
  const deleted = new Set<string>();
  // A deleted dataset made again gets a database of its own, as a new Turso
  // database of the same name would be empty.
  const generation = new Map<string, number>();
  const id = ({ kind, provider, key = "" }: SyncDatabaseKey) =>
    `${kind}-${provider}-${key}`;
  const databaseOf = (name: string) =>
    `${project}-${name}-${generation.get(name) ?? 0}`;
  return {
    async getSyncDatabase(request: SyncDatabaseRequest) {
      const name = id(request);
      if (deleted.has(name)) {
        if (!request.create) {
          // As the cloud does, naming the database deleted.
          const syncId = databaseOf(name);
          throw new EvalutionApiError(410, "deleted", {
            error: "deleted",
            syncId,
          });
        }
        deleted.delete(name);
        generation.set(name, (generation.get(name) ?? 0) + 1);
      }
      live.set(name, {
        kind: request.kind,
        provider: request.provider,
        key: request.key ?? "",
      });
      const database = databaseOf(name);
      const url = `${serverUrl}/db/${database}`;
      if (!enforced.has(database)) {
        await enforceForeignKeys(url);
        enforced.add(database);
      }
      return {
        url,
        token: "unused-by-the-local-server",
        expiresAt: Date.now() + 3_600_000,
        syncId: database,
        projectId: project,
      };
    },
    async listSyncDatabases() {
      return [...live.values()];
    },
    async deleteSyncDatabase(key) {
      const name = id(key);
      if (!live.delete(name)) throw new EvalutionApiError(404, "not found");
      deleted.add(name);
    },
  };
}

/** One machine's checkout of the project, new to it. */
async function machine(cloud: WorkspaceCloud) {
  return machineAt(
    await mkdtemp(join(tmpdir(), "evalution-sync-machine-")),
    cloud,
  );
}

const span = (traceId: string) => ({
  id: `${traceId}:root`,
  traceId,
  name: traceId,
  kind: "LLM" as const,
  startTime: Date.now(),
});

const traceIds = async (m: Awaited<ReturnType<typeof machine>>) =>
  (await m.traces.getAllTraces()).map(t => t.id).sort();

describe.skipIf(!tursodb)("workspace sync through a Turso sync server", () => {
  let server: ChildProcess;
  let serverUrl: string;
  let serverDir: string;
  let projects = 0;
  /** A new project's cloud: its databases are its own. */
  const newProject = () => fakeCloud(serverUrl, `p${++projects}`);

  beforeAll(async () => {
    serverDir = await mkdtemp(join(tmpdir(), "evalution-sync-server-"));
    const port = await freePort();
    serverUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      tursodb as string,
      ["--sync-dir", serverDir, "--sync-server", `127.0.0.1:${port}`],
      { stdio: "ignore" },
    );
    await waitForServer(serverUrl);
  });

  afterAll(async () => {
    server?.kill();
    await rm(serverDir, { recursive: true, force: true });
  });

  it("brings one machine's traces to a machine new to the project", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    await a.traces.recordSpanStart(span("from-a"));
    await a.syncNow();

    const b = await machine(cloud);

    expect(await traceIds(b)).toEqual(["from-a"]);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("keeps each provider of a kind in its own cloud database", async () => {
    const cloud = newProject();
    const checkout = async () => {
      const root = await mkdtemp(join(tmpdir(), "evalution-sync-machine-"));
      const sync = new WorkspaceSync({ cloud, log: { warn() {} } });
      const local = new LocalDatabaseTraceProvider({
        path: join(root, "local.db"),
      });
      const scratch = new LocalDatabaseTraceProvider({
        path: join(root, "scratch.db"),
        id: "scratch",
      });
      sync.syncProviders({ traces: [local, scratch], datasets: [], evals: [] });
      await local.getAllTraces();
      await scratch.getAllTraces();
      return {
        sync,
        local,
        scratch,
        async stop() {
          await sync.close();
          await rm(root, { recursive: true, force: true });
        },
      };
    };
    const ids = async (provider: LocalDatabaseTraceProvider) =>
      (await provider.getAllTraces()).map(t => t.id);
    const a = await checkout();
    await a.local.recordSpanStart(span("in-local"));
    await a.scratch.recordSpanStart(span("in-scratch"));
    await a.sync.pullAll();

    const b = await checkout();

    expect(await ids(b.local)).toEqual(["in-local"]);
    expect(await ids(b.scratch)).toEqual(["in-scratch"]);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("merges a machine's own traces with the project's when it starts syncing", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    await a.traces.recordSpanStart(span("from-a"));
    await a.syncNow();
    // B recorded traces before it was linked.
    const offline: WorkspaceCloud = {
      ...cloud,
      getSyncDatabase: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const bOffline = await machine(offline);
    await bOffline.traces.recordSpanStart(span("from-b"));
    await bOffline.sync.close();
    await bOffline.datasets.close();
    const b = await machineAt(bOffline.root, cloud);

    await b.syncNow();
    await a.syncNow();

    expect(await traceIds(a)).toEqual(["from-a", "from-b"]);
    expect(await traceIds(b)).toEqual(["from-a", "from-b"]);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("catches up once the cloud answers, after opening without it", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    await a.traces.recordSpanStart(span("from-a"));
    await a.syncNow();
    let reachable = false;
    const flaky: WorkspaceCloud = {
      ...cloud,
      getSyncDatabase: async request => {
        if (!reachable) throw new TypeError("fetch failed");
        return cloud.getSyncDatabase(request);
      },
    };

    const b = await machine(flaky);
    expect(await traceIds(b)).toEqual([]);
    reachable = true;
    await b.syncNow();

    expect(await traceIds(b)).toEqual(["from-a"]);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("opens a shared link to a trace recorded on another machine since the last pull", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    const b = await machine(cloud);
    await a.traces.recordSpanStart(span("shared"));
    await a.syncNow();

    const found = await b.traces.getTrace("shared");

    expect(found?.trace.id).toBe("shared");
    await Promise.all([a.stop(), b.stop()]);
  });

  it("syncs deletes, and annotations", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    const b = await machine(cloud);
    await a.traces.recordSpanStart(span("keep"));
    await a.traces.recordSpanStart(span("drop"));
    await a.traces.createAnnotation({
      traceId: "keep",
      kind: "issue",
      note: "wrong answer",
      source: "user",
    });
    await a.syncNow();
    await b.syncNow();
    expect(await traceIds(b)).toEqual(["drop", "keep"]);

    await b.traces.deleteTrace("drop");
    await b.syncNow();
    await a.syncNow();

    expect(await traceIds(a)).toEqual(["keep"]);
    expect(await b.traces.listAnnotations("keep")).toMatchObject([
      { note: "wrong answer" },
    ]);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("syncs evals", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    const b = await machine(cloud);
    const created = await a.evals.createEval({
      name: "Plans tasks",
      prompt: { id: "odin" },
      dataset: { providerId: "local-datasets", id: "tickets" },
      inputs: { functionInputs: {}, executeInputs: {} },
      checks: [],
    });
    await a.syncNow();
    await b.syncNow();

    expect(await b.evals.getEval(created.id)).toMatchObject({
      name: "Plans tasks",
    });
    await Promise.all([a.stop(), b.stop()]);
  });

  it("brings a dataset made on one machine to another, rows and all", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    const b = await machine(cloud);
    const dataset = await a.datasets.createDataset({
      name: "Tickets",
      fields: [],
    });
    await a.datasets.addRows(dataset.id, [{ cells: {} }, { cells: {} }]);
    await a.syncNow();

    await b.syncNow();

    expect(await b.datasets.listDatasets()).toMatchObject([
      { id: "tickets", name: "Tickets", rowCount: 2 },
    ]);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("deletes a dataset from every machine's sync, and lets its id be used afresh", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    const b = await machine(cloud);
    const dataset = await a.datasets.createDataset({
      name: "Tickets",
      fields: [],
    });
    await a.datasets.addRows(dataset.id, [{ cells: {} }]);
    await a.syncNow();
    await b.syncNow();

    await a.datasets.deleteDataset(dataset.id);
    const again = await a.datasets.createDataset({
      name: "Tickets",
      fields: [],
    });
    await a.syncNow();
    const c = await machine(cloud);
    await c.syncNow();

    expect(again.id).toBe("tickets");
    expect(await c.datasets.listDatasets()).toMatchObject([
      { id: "tickets", rowCount: 0 },
    ]);
    await Promise.all([a.stop(), b.stop(), c.stop()]);
  });

  it("starts syncing a project that was never linked, bringing its traces and datasets", async () => {
    const root = await mkdtemp(join(tmpdir(), "evalution-sync-machine-"));
    const before = unlinkedAt(root);
    await before.traces.recordSpanStart(span("before-linking"));
    const made = await before.datasets.createDataset({
      name: "Tickets",
      fields: [],
    });
    await before.datasets.addRows(made.id, [{ cells: {} }]);
    await before.datasets.close();
    const cloud = newProject();

    const linked = await machineAt(root, cloud);
    await linked.syncNow();
    const other = await machine(cloud);
    await other.syncNow();

    expect(await traceIds(other)).toEqual(["before-linking"]);
    expect(await other.datasets.listDatasets()).toMatchObject([
      { id: "tickets", rowCount: 1 },
    ]);
    await Promise.all([linked.stop(), other.stop()]);
  });

  it("unions the fields of a dataset two machines each made before one linked", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    const ours = await a.datasets.createDataset({
      name: "Tickets",
      fields: [{ def: def("question") }, { def: def("answer") }],
    });
    await a.datasets.addRows(ours.id, [{ cells: { "0": text("q1") } }]);
    await a.syncNow();
    const root = await mkdtemp(join(tmpdir(), "evalution-sync-machine-"));
    const before = unlinkedAt(root);
    const theirs = await before.datasets.createDataset({
      name: "Tickets",
      fields: [{ def: def("answer") }, { def: def("notes") }],
    });
    await before.datasets.addRows(theirs.id, [
      { cells: { "0": text("a2"), "1": text("n2") } },
    ]);
    await before.datasets.close();

    const b = await machineAt(root, cloud);
    await b.syncNow();
    await a.syncNow();

    const dataset = await a.datasets.getDataset("tickets");
    expect(dataset?.fields.map(f => f.def.name)).toEqual([
      "question",
      "answer",
      "notes",
    ]);
    const cells = (await a.datasets.listRows("tickets")).map(r => r.cells);
    expect(cells).toEqual(
      expect.arrayContaining([
        { "0": text("q1") },
        { "1": text("a2"), "2": text("n2") },
      ]),
    );
    await Promise.all([a.stop(), b.stop()]);
  });

  it("starts over from a dataset deleted and made again since this machine synced it", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    const old = await a.datasets.createDataset({ name: "Tickets", fields: [] });
    await a.datasets.addRows(old.id, [{ cells: {} }, { cells: {} }]);
    await a.syncNow();
    const b = await machine(cloud);
    await b.syncNow();
    await b.sync.close();
    await b.datasets.close();

    await a.datasets.deleteDataset(old.id);
    const again = await a.datasets.createDataset({
      name: "Tickets",
      fields: [],
    });
    await a.datasets.addRows(again.id, [{ cells: {} }]);
    await a.syncNow();
    const bAgain = await machineAt(b.root, cloud);
    await bAgain.syncNow();

    expect(await bAgain.datasets.listDatasets()).toMatchObject([
      { id: "tickets", rowCount: 1 },
    ]);
    await Promise.all([a.stop(), bAgain.stop()]);
  });

  it("removes a dataset deleted on another machine", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    const tickets = await a.datasets.createDataset({
      name: "Tickets",
      fields: [],
    });
    await a.datasets.addRows(tickets.id, [{ cells: {} }]);
    await a.syncNow();
    const b = await machine(cloud);
    await b.syncNow();
    expect(await b.datasets.listDatasets()).toMatchObject([{ id: "tickets" }]);
    const removed: string[] = [];
    b.datasets.watch(event => {
      if (event.type === "remove") removed.push(event.datasetId);
    });

    await a.datasets.deleteDataset(tickets.id);
    await b.syncNow();

    expect(await b.datasets.listDatasets()).toEqual([]);
    expect(existsSync(join(b.root, "datasets", "tickets.db"))).toBe(false);
    expect(removed).toEqual(["tickets"]);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("removes a dataset deleted while this machine was off", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    await a.datasets.createDataset({ name: "Tickets", fields: [] });
    await a.syncNow();
    const b = await machine(cloud);
    await b.syncNow();
    await b.sync.close();
    await b.datasets.close();

    await a.datasets.deleteDataset("tickets");
    const bAgain = await machineAt(b.root, cloud);
    await bAgain.syncNow();

    expect(await bAgain.datasets.listDatasets()).toEqual([]);
    await Promise.all([a.stop(), bAgain.stop()]);
  });

  it("keeps a dataset made here, unsynced, with the id of one deleted from the project", async () => {
    const cloud = newProject();
    const a = await machine(cloud);
    await a.datasets.createDataset({ name: "Tickets", fields: [] });
    await a.syncNow();
    await a.datasets.deleteDataset("tickets");
    const root = await mkdtemp(join(tmpdir(), "evalution-sync-machine-"));
    const before = unlinkedAt(root);
    const mine = await before.datasets.createDataset({
      name: "Tickets",
      fields: [],
    });
    await before.datasets.addRows(mine.id, [{ cells: {} }]);
    await before.datasets.close();

    const b = await machineAt(root, cloud);
    await b.syncNow();

    expect(await b.datasets.listDatasets()).toMatchObject([
      { id: "tickets", rowCount: 1 },
    ]);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("brings a machine's traces to the next project it's linked to", async () => {
    const first = await machine(newProject());
    await first.traces.recordSpanStart(span("from-the-first-project"));
    await first.syncNow();
    await first.sync.close();
    await first.datasets.close();
    const next = newProject();

    const relinked = await machineAt(first.root, next);
    await relinked.syncNow();
    const other = await machine(next);

    expect(await traceIds(other)).toEqual(["from-the-first-project"]);
    await Promise.all([relinked.stop(), other.stop()]);
  });

  it("pushes rows that reference others when a file is adopted", async () => {
    const root = await mkdtemp(join(tmpdir(), "evalution-sync-machine-"));
    const before = unlinkedAt(root);
    await before.traces.recordSpanStart(span("annotated"));
    await before.traces.createAnnotation({
      traceId: "annotated",
      kind: "issue",
      note: "wrong answer",
      source: "user",
    });
    const evalDef = await before.evals.createEval({
      name: "Plans tasks",
      prompt: { id: "odin" },
      dataset: { providerId: "local-datasets", id: "tickets" },
      inputs: { functionInputs: {}, executeInputs: {} },
      checks: [],
    });
    const run = await before.evals.createRun(evalDef.id, {
      definition: evalDef,
      arms: [{ id: "a0", label: "Working tree", spec: { kind: "head" } }],
      dirty: true,
      concurrency: 1,
      total: 1,
    });
    await before.datasets.close();
    const cloud = newProject();

    const linked = await machineAt(root, cloud);
    await linked.syncNow();
    const other = await machine(cloud);

    expect(await other.traces.listAnnotations("annotated")).toMatchObject([
      { note: "wrong answer" },
    ]);
    expect(await other.evals.listRuns(evalDef.id)).toMatchObject([
      { id: run.id },
    ]);
    await Promise.all([linked.stop(), other.stop()]);
  });

  it("keeps the writes made while a file is adopted", async () => {
    const root = await mkdtemp(join(tmpdir(), "evalution-sync-machine-"));
    const before = unlinkedAt(root);
    for (let i = 0; i < 50; i++) {
      await before.traces.recordSpanStart(span(`before-${i}`));
    }
    await before.datasets.close();
    const cloud = newProject();

    const linked = await machineAt(root, cloud);
    const syncing = linked.syncNow();
    const during = Array.from({ length: 20 }, (_, i) =>
      linked.traces.recordSpanStart(span(`during-${i}`)),
    );
    await Promise.all([syncing, ...during]);
    await linked.syncNow();
    const other = await machine(cloud);

    expect(await traceIds(other)).toHaveLength(70);
    await Promise.all([linked.stop(), other.stop()]);
  });
});

/** A checkout of a project that isn't linked to Evalution Cloud. */
function unlinkedAt(root: string) {
  return {
    traces: new LocalDatabaseTraceProvider({
      path: join(root, "traces", "local.db"),
    }),
    evals: new LocalEvalProvider({ path: join(root, "evals", "evals.db") }),
    datasets: new LocalDirectoryDatasetProvider({
      dir: join(root, "datasets"),
    }),
  };
}

/** One machine's checkout of the project at `root`: its own files, providers and sync. */
async function machineAt(root: string, cloud: WorkspaceCloud) {
  const sync = new WorkspaceSync({ cloud, log: { warn() {} } });
  const traces = new LocalDatabaseTraceProvider({
    path: join(root, "traces", "local.db"),
  });
  const evals = new LocalEvalProvider({
    path: join(root, "evals", "evals.db"),
  });
  const datasets = new LocalDirectoryDatasetProvider({
    dir: join(root, "datasets"),
  });
  // As `setUpProject` does.
  sync.syncProviders({
    traces: [traces],
    datasets: [datasets],
    evals: [evals],
  });
  // Opening finishes on the first read.
  await traces.getAllTraces();
  await evals.listEvals();
  return {
    root,
    sync,
    traces,
    evals,
    datasets,
    /** Pushes what this machine has, and pulls what others pushed. */
    async syncNow() {
      await sync.pullAll();
      await sync.pullAll();
    },
    async stop() {
      await sync.close();
      await datasets.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
