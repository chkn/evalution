// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { SyncDatabaseKey } from "@evalution/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WorkspaceCloud, WorkspaceSync } from "./workspace-sync.ts";

function fakeCloud(remote: Required<SyncDatabaseKey>[] = []) {
  const deleted: string[] = [];
  let listFails = false;
  const cloud: WorkspaceCloud = {
    async getSyncDatabase() {
      return {
        url: "libsql://db.turso.io",
        token: "t",
        expiresAt: Date.now() + 3_600_000,
        syncId: "db-1",
        projectId: "prj_1",
      };
    },
    async listSyncDatabases() {
      if (listFails) throw new TypeError("fetch failed");
      return remote;
    },
    async deleteSyncDatabase(key) {
      deleted.push(`${key.provider}/${key.key}`);
    },
  };
  return {
    cloud,
    deleted,
    failListing() {
      listFails = true;
    },
  };
}

function fakeDb() {
  const ops: string[] = [];
  return {
    ops,
    db: {
      push: async () => {
        ops.push("push");
      },
      pull: async () => {
        ops.push("pull");
        return false;
      },
      checkpoint: async () => {
        ops.push("checkpoint");
      },
    },
  };
}

const quiet = { warn: vi.fn() };

const linked = { links: ["db-1"], onPulled: () => {}, adopt: async () => {} };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceSync", () => {
  it("has one sync per database", () => {
    const sync = new WorkspaceSync({ cloud: fakeCloud().cloud, log: quiet });

    const traces = sync.database({ kind: "traces", provider: "a" }, 1);

    expect(sync.database({ kind: "traces", provider: "a" }, 1)).toBe(traces);
    expect(sync.database({ kind: "traces", provider: "b" }, 1)).not.toBe(
      traces,
    );
    expect(sync.database({ kind: "evals", provider: "a" }, 1)).not.toBe(traces);
    expect(
      sync.database({ kind: "dataset", provider: "d", key: "a" }, 1),
    ).not.toBe(sync.database({ kind: "dataset", provider: "d", key: "b" }, 1));
  });

  it("pulls every attached database on an interval, and checkpoints less often", async () => {
    const sync = new WorkspaceSync({
      cloud: fakeCloud().cloud,
      log: quiet,
      pullIntervalMs: 1000,
      checkpointEvery: 3,
    });
    const traces = sync.database({ kind: "traces", provider: "t" }, 1);
    await traces.prepare();
    const { db, ops } = fakeDb();
    traces.attach(db, linked);
    await traces.idle();
    ops.length = 0;

    sync.start();
    await vi.advanceTimersByTimeAsync(3000);

    expect(ops).toEqual(["pull", "pull", "pull", "checkpoint"]);
    await sync.close();
  });

  it("runs what's waiting on a pull after every database has pulled", async () => {
    const sync = new WorkspaceSync({ cloud: fakeCloud().cloud, log: quiet });
    const hook = vi.fn(async () => {});
    sync.onPull(hook);

    await sync.pullAll();

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("shares a pull that's already in flight", async () => {
    const sync = new WorkspaceSync({ cloud: fakeCloud().cloud, log: quiet });
    let release = () => {};
    const hook = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    sync.onPull(hook);

    const first = sync.pullAll();
    const second = sync.pullAll();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([first, second]);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("lists a provider's datasets in the cloud", async () => {
    const sync = new WorkspaceSync({
      cloud: fakeCloud([
        { kind: "traces", provider: "local-datasets", key: "" },
        { kind: "dataset", provider: "local-datasets", key: "a" },
        { kind: "dataset", provider: "local-datasets", key: "b" },
        { kind: "dataset", provider: "other", key: "c" },
      ]).cloud,
      log: quiet,
    });

    expect(await sync.remoteDatasetIds("local-datasets")).toEqual(["a", "b"]);
  });

  it("says it doesn't know when the cloud can't be reached", async () => {
    const { cloud, failListing } = fakeCloud();
    failListing();
    const sync = new WorkspaceSync({ cloud, log: quiet });

    expect(await sync.remoteDatasetIds("local-datasets")).toBeUndefined();
  });

  it("deletes a dataset's cloud copy, and forgets its sync", async () => {
    const { cloud, deleted } = fakeCloud();
    const sync = new WorkspaceSync({ cloud, log: quiet });
    const key = { kind: "dataset", provider: "d", key: "a" } as const;
    const before = sync.database(key, 1);

    await sync.deleteDataset("d", "a");

    expect(deleted).toEqual(["d/a"]);
    expect(sync.database(key, 1)).not.toBe(before);
  });

  it("forgets the sync of a dataset deleted elsewhere, so one made again here syncs", async () => {
    const { cloud, deleted } = fakeCloud();
    const sync = new WorkspaceSync({ cloud, log: quiet });
    const key = { kind: "dataset", provider: "d", key: "a" } as const;
    const before = sync.database(key, 1);

    await sync.forgetDataset("d", "a");

    expect(deleted).toEqual([]);
    expect(sync.database(key, 1)).not.toBe(before);
  });

  it("pushes every database on close, and stops pulling", async () => {
    const sync = new WorkspaceSync({
      cloud: fakeCloud().cloud,
      log: quiet,
      pullIntervalMs: 1000,
    });
    const traces = sync.database({ kind: "traces", provider: "t" }, 1);
    await traces.prepare();
    const { db, ops } = fakeDb();
    traces.attach(db, linked);
    await traces.idle();
    ops.length = 0;
    traces.noteWrite();
    sync.start();

    await sync.close();
    await vi.advanceTimersByTimeAsync(5000);

    expect(ops).toEqual(["push"]);
  });

  it("says which databases are being adopted, and when that changes", async () => {
    const sync = new WorkspaceSync({ cloud: fakeCloud().cloud, log: quiet });
    const dataset = sync.database(
      { kind: "dataset", provider: "d", key: "a" },
      1,
    );
    await dataset.prepare();
    const changes = vi.fn();
    sync.onStatusChange(changes);
    let finish = () => {};

    dataset.attach(fakeDb().db, {
      links: [],
      onPulled: () => {},
      adopt: () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    });

    expect(sync.adopting()).toEqual([
      { kind: "dataset", provider: "d", key: "a" },
    ]);
    finish();
    await dataset.adopted();
    expect(sync.adopting()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("waits for the adoptions a pull starts, then pulls and pushes the adopted file", async () => {
    const sync = new WorkspaceSync({ cloud: fakeCloud().cloud, log: quiet });
    const traces = sync.database({ kind: "traces", provider: "t" }, 1);
    const adopted = fakeDb();
    traces.attach(fakeDb().db, {
      links: [],
      onPulled: () => {},
      adopt: async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        traces.attach(adopted.db, linked);
      },
    });

    const pulled = sync.pullAll();
    await vi.advanceTimersByTimeAsync(100);
    await pulled;

    expect(adopted.ops).toEqual(["pull", "push", "pull"]);
  });

  describe("syncProviders", () => {
    /** A provider that can sync, recording the sync it's given. */
    const provider = (id: string) => ({
      id,
      given: [] as WorkspaceSync[],
      _ecSetSync(sync: WorkspaceSync) {
        this.given.push(sync);
      },
    });

    it("gives every provider that can sync the sync, whoever made it", () => {
      const sync = new WorkspaceSync({ cloud: fakeCloud().cloud, log: quiet });
      const traces = provider("local-db");
      const other = provider("scratch");
      const datasets = provider("local-datasets");
      const evals = provider("local-evals");

      sync.syncProviders({
        traces: [traces, { id: "cloud" }, other],
        datasets: [datasets],
        evals: [evals],
      });

      for (const p of [traces, other, datasets, evals]) {
        expect(p.given).toEqual([sync]);
      }
    });

    it("gives a provider listed twice the sync once", () => {
      const sync = new WorkspaceSync({ cloud: fakeCloud().cloud, log: quiet });
      const traces = provider("local-db");

      sync.syncProviders({ traces: [traces, traces], datasets: [], evals: [] });

      expect(traces.given).toHaveLength(1);
    });

    it("syncs only the first of a kind's providers that share an id, saying so", () => {
      const log = { warn: vi.fn() };
      const sync = new WorkspaceSync({ cloud: fakeCloud().cloud, log });
      const first = provider("same");
      const second = provider("same");
      const evals = provider("same");

      sync.syncProviders({
        traces: [first, second],
        datasets: [],
        evals: [evals],
      });

      expect(first.given).toHaveLength(1);
      expect(second.given).toHaveLength(0);
      // Another kind's provider may share it: their databases are apart.
      expect(evals.given).toHaveLength(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Two trace providers have the id "same"'),
      );
    });
  });
});
