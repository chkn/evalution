// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  EvalutionApiError,
  type SyncDatabaseCredentials,
  type SyncDatabaseRequest,
} from "@evalution/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SyncCloud } from "./database-sync.ts";

const HOUR = 60 * 60 * 1000;

/** A cloud that hands out credentials, or fails as told. */
function fakeCloud() {
  const requests: SyncDatabaseRequest[] = [];
  let tokens = 0;
  let failWith: Error | undefined;
  const cloud: SyncCloud = {
    async getSyncDatabase(request) {
      requests.push(request);
      if (failWith) throw failWith;
      tokens++;
      return {
        url: "libsql://db.turso.io",
        token: `token-${tokens}`,
        expiresAt: Date.now() + HOUR,
        syncId: "db-1",
        projectId: "prj_1",
      } satisfies SyncDatabaseCredentials;
    },
  };
  return {
    cloud,
    requests,
    fail(error: Error | undefined) {
      failWith = error;
    },
  };
}

/** A synced database that records what it's asked to do. */
function fakeDb() {
  const ops: string[] = [];
  let pulled = false;
  let fail: Error | undefined;
  return {
    ops,
    db: {
      async push() {
        ops.push("push");
        if (fail) throw fail;
      },
      async pull() {
        ops.push("pull");
        if (fail) throw fail;
        return pulled;
      },
      async checkpoint() {
        ops.push("checkpoint");
      },
    },
    willPull(changes: boolean) {
      pulled = changes;
    },
    failWith(error: Error | undefined) {
      fail = error;
    },
  };
}

const log = () => ({ warn: vi.fn() });

/** Attach options for a file that holds the cloud database's rows. */
const linked = (onPulled: () => void = () => {}) => ({
  links: ["db-1"],
  onPulled,
  adopt: async () => {},
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DatabaseSync", () => {
  it("syncs a file only once the cloud has answered and the file holds its database's rows", async () => {
    const { cloud, requests } = fakeCloud();
    const { db } = fakeDb();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 4,
      log: log(),
    });
    sync.attach(db, linked());

    expect(sync.getCloudUrl()).toBeNull();
    await sync.prepare();

    expect(sync.getCloudUrl()).toBe("libsql://db.turso.io");
    expect(await sync.getAuthToken()).toBe("token-1");
    expect(requests).toEqual([
      { kind: "traces", provider: "local-db", schemaVersion: 4 },
    ]);
  });

  it("does nothing when the same database is attached again", async () => {
    const { cloud } = fakeCloud();
    const { db, ops } = fakeDb();
    const adopt = vi.fn(async () => {});
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: log(),
    });
    await sync.prepare();
    sync.attach(db, { links: [], onPulled: () => {}, adopt });
    await sync.adopted();

    sync.attach(db, { links: [], onPulled: () => {}, adopt });
    await sync.adopted();

    expect(adopt).toHaveBeenCalledTimes(1);
    expect(ops).toEqual([]);
  });

  it("hands the engine the URL while a new file is made from the cloud's copy", async () => {
    const { cloud } = fakeCloud();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: log(),
    });
    await sync.prepare();
    expect(sync.getCloudUrl()).toBeNull();

    sync.beginBootstrap();
    expect(sync.getCloudUrl()).toBe("libsql://db.turso.io");

    expect(sync.endBootstrap()).toMatchObject({ syncId: "db-1" });
    expect(sync.getCloudUrl()).toBeNull();
  });

  it("makes a new file empty, unlinked, without the cloud's answer or when fetching its copy fails", async () => {
    const { cloud } = fakeCloud();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: log(),
    });
    sync.beginBootstrap();
    expect(sync.getCloudUrl()).toBeNull();
    expect(sync.endBootstrap()).toBeUndefined();

    await sync.prepare();
    sync.beginBootstrap();
    sync.reportBootstrapFailure(new Error("fetch failed"));

    expect(sync.getCloudUrl()).toBeNull();
    expect(sync.endBootstrap()).toBeUndefined();
  });

  it("asks to create the database when told it's new", async () => {
    const { cloud, requests } = fakeCloud();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "dataset", provider: "local-datasets", key: "questions" },
      schemaVersion: 2,
      log: log(),
    });

    await sync.prepare({ create: true });

    expect(requests).toEqual([
      {
        kind: "dataset",
        provider: "local-datasets",
        key: "questions",
        schemaVersion: 2,
        create: true,
      },
    ]);
  });

  it("asks to create the database only until the cloud has made it", async () => {
    const { cloud, requests } = fakeCloud();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "dataset", provider: "local-datasets", key: "questions" },
      schemaVersion: 2,
      log: log(),
    });
    await sync.prepare({ create: true });

    // A later token mustn't bring the dataset back if it's deleted meanwhile.
    vi.advanceTimersByTime(HOUR);
    await sync.getAuthToken();

    expect(requests.map(request => request.create)).toEqual([true, undefined]);
  });

  it("gets a new token shortly before the old one expires", async () => {
    const { cloud } = fakeCloud();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "evals", provider: "local-evals" },
      schemaVersion: 1,
      log: log(),
    });
    await sync.prepare();
    expect(await sync.getAuthToken()).toBe("token-1");

    vi.advanceTimersByTime(HOUR - 10 * 60 * 1000);
    expect(await sync.getAuthToken()).toBe("token-1");

    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(await sync.getAuthToken()).toBe("token-2");
  });

  it("doesn't hold up opening the database when the cloud is slow", async () => {
    const cloud: SyncCloud = { getSyncDatabase: () => new Promise(() => {}) };
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      prepareTimeoutMs: 2000,
      log: log(),
    });

    const prepared = sync.prepare();
    await vi.advanceTimersByTimeAsync(2000);
    await prepared;

    expect(sync.getCloudUrl()).toBeNull();
  });

  it("keeps trying to reach the cloud, and syncs once it can", async () => {
    const { cloud, fail } = fakeCloud();
    const warn = log();
    const { db, ops } = fakeDb();
    fail(new TypeError("fetch failed"));
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: warn,
    });
    await sync.prepare();
    sync.attach(db, linked());
    await sync.pull();
    expect(sync.getCloudUrl()).toBeNull();
    expect(ops).toEqual([]);
    expect(warn.warn).toHaveBeenCalledTimes(1);

    fail(undefined);
    await sync.pull();

    expect(sync.getCloudUrl()).toBe("libsql://db.turso.io");
    expect(ops).toEqual(["pull", "push"]);
  });

  it.each([
    [409, "newer evalution"],
    [410, "deleted"],
    [404, "cannot access"],
    [403, "didn't accept"],
  ])("stops syncing for good when the cloud answers %i", async (status, message) => {
    const { cloud, fail, requests } = fakeCloud();
    const warn = log();
    fail(new EvalutionApiError(status, `${message} (detail)`));
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: warn,
    });
    const { db, ops } = fakeDb();

    await sync.prepare();
    sync.attach(db, linked());
    await sync.pull();
    await sync.pull();

    expect(sync.getCloudUrl()).toBeNull();
    expect(sync.isStopped).toBe(true);
    expect(requests).toHaveLength(1);
    expect(ops).toEqual([]);
    expect(warn.warn).toHaveBeenCalledTimes(1);
  });

  it("pulls then pushes when attached, and reports pulled changes", async () => {
    const { cloud } = fakeCloud();
    const { db, ops, willPull } = fakeDb();
    const onPulled = vi.fn();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: log(),
    });
    await sync.prepare();
    willPull(true);

    sync.attach(db, linked(onPulled));
    await sync.idle();

    expect(ops).toEqual(["pull", "push"]);
    expect(onPulled).toHaveBeenCalledTimes(1);

    willPull(false);
    expect(await sync.pull()).toBe(false);
    expect(onPulled).toHaveBeenCalledTimes(1);
  });

  it("pushes once after a burst of writes", async () => {
    const { cloud } = fakeCloud();
    const { db, ops } = fakeDb();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      pushDelayMs: 1000,
      log: log(),
    });
    await sync.prepare();
    sync.attach(db, linked());
    await sync.idle();
    ops.length = 0;

    sync.noteWrite();
    await vi.advanceTimersByTimeAsync(500);
    sync.noteWrite();
    await vi.advanceTimersByTimeAsync(500);
    sync.noteWrite();
    expect(ops).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    await sync.idle();
    expect(ops).toEqual(["push"]);
  });

  it("never runs two operations on the database at once", async () => {
    const { cloud } = fakeCloud();
    const ops: string[] = [];
    let running = 0;
    const step = (name: string) => async () => {
      expect(running).toBe(0);
      running++;
      ops.push(name);
      await new Promise(resolve => setTimeout(resolve, 10));
      running--;
      return false;
    };
    const db = {
      push: step("push"),
      pull: step("pull"),
      checkpoint: step("checkpoint"),
    };
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: log(),
    });
    await sync.prepare();
    sync.attach(db, linked());

    const all = Promise.all([sync.pull(), sync.checkpoint(), sync.pull()]);
    await vi.runAllTimersAsync();
    await all;

    expect(ops).toEqual(["pull", "push", "pull", "checkpoint", "pull"]);
  });

  it("warns once while syncing keeps failing, and again after it recovers", async () => {
    const { cloud } = fakeCloud();
    const { db, failWith } = fakeDb();
    const warn = log();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: warn,
    });
    await sync.prepare();
    failWith(new Error("network down"));
    sync.attach(db, linked());
    await sync.idle();
    await sync.pull();
    expect(warn.warn).toHaveBeenCalledTimes(1);
    expect(warn.warn.mock.calls[0][0]).toContain("network down");

    failWith(undefined);
    await sync.pull();
    failWith(new Error("again"));
    await sync.pull();
    expect(warn.warn).toHaveBeenCalledTimes(2);
  });

  it("does nothing before it's attached to a database", async () => {
    const { cloud } = fakeCloud();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      log: log(),
    });
    await sync.prepare();

    expect(await sync.pull()).toBe(false);
    sync.noteWrite();
    await sync.checkpoint();
  });

  it("pushes what's left on close, and then stops", async () => {
    const { cloud } = fakeCloud();
    const { db, ops } = fakeDb();
    const sync = new DatabaseSync({
      cloud,
      key: { kind: "traces", provider: "local-db" },
      schemaVersion: 1,
      pushDelayMs: 1000,
      log: log(),
    });
    await sync.prepare();
    sync.attach(db, linked());
    await sync.idle();
    ops.length = 0;
    sync.noteWrite();

    await sync.close();
    await vi.advanceTimersByTimeAsync(5000);
    await sync.pull();

    expect(ops).toEqual(["push"]);
  });

  describe("a file with no link to the cloud's database", () => {
    it("is adopted, not synced, once the cloud answers", async () => {
      const { cloud, fail } = fakeCloud();
      const { db, ops } = fakeDb();
      const adopt = vi.fn(async () => {});
      const onStatusChange = vi.fn();
      fail(new TypeError("fetch failed"));
      const sync = new DatabaseSync({
        cloud,
        key: { kind: "traces", provider: "local-db" },
        schemaVersion: 1,
        onStatusChange,
        log: log(),
      });
      await sync.prepare();
      sync.attach(db, { links: [], onPulled: () => {}, adopt });
      expect(adopt).not.toHaveBeenCalled();

      fail(undefined);
      expect(await sync.pull()).toBe(false);
      await sync.adopted();

      expect(adopt).toHaveBeenCalledTimes(1);
      expect(ops).toEqual([]);
      expect(sync.getCloudUrl()).toBeNull();
      expect(onStatusChange).toHaveBeenCalledTimes(2);
    });

    it("is adopted when its link is to another cloud database", async () => {
      const { cloud } = fakeCloud();
      const { db } = fakeDb();
      const adopt = vi.fn(async () => {});
      const sync = new DatabaseSync({
        cloud,
        key: { kind: "traces", provider: "local-db" },
        schemaVersion: 1,
        log: log(),
      });
      await sync.prepare();

      sync.attach(db, { links: ["db-0"], onPulled: () => {}, adopt });
      await sync.adopted();

      expect(adopt).toHaveBeenCalledTimes(1);
    });

    it("syncs once the adopted file is attached", async () => {
      const { cloud } = fakeCloud();
      const old = fakeDb();
      const adopted = fakeDb();
      const sync = new DatabaseSync({
        cloud,
        key: { kind: "traces", provider: "local-db" },
        schemaVersion: 1,
        log: log(),
      });
      await sync.prepare();

      sync.attach(old.db, {
        links: [],
        onPulled: () => {},
        adopt: async () => sync.attach(adopted.db, linked()),
      });
      await sync.adopted();
      await sync.idle();

      expect(old.ops).toEqual([]);
      expect(adopted.ops).toEqual(["pull", "push"]);
      expect(sync.getCloudUrl()).toBe("libsql://db.turso.io");
    });

    it("says it's being adopted until the adoption settles, which a pull doesn't wait for", async () => {
      const { cloud } = fakeCloud();
      const { db } = fakeDb();
      let finish: () => void = () => {};
      const sync = new DatabaseSync({
        cloud,
        key: { kind: "traces", provider: "local-db" },
        schemaVersion: 1,
        log: log(),
      });
      await sync.prepare();

      sync.attach(db, {
        links: [],
        onPulled: () => {},
        adopt: () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      });
      expect(sync.isAdopting).toBe(true);
      expect(await sync.pull()).toBe(false);

      finish();
      await sync.adopted();
      expect(sync.isAdopting).toBe(false);
    });

    it("tries again on the next pull after an adoption fails, warning once", async () => {
      const { cloud } = fakeCloud();
      const { db } = fakeDb();
      const warn = log();
      const adopt = vi.fn(async () => {
        throw new Error("couldn't fetch the copy");
      });
      const sync = new DatabaseSync({
        cloud,
        key: { kind: "traces", provider: "local-db" },
        schemaVersion: 1,
        log: warn,
      });
      await sync.prepare();
      sync.attach(db, { links: [], onPulled: () => {}, adopt });
      await sync.adopted();

      await sync.pull();
      await sync.adopted();

      expect(adopt).toHaveBeenCalledTimes(2);
      expect(warn.warn).toHaveBeenCalledTimes(1);
      expect(warn.warn.mock.calls[0][0]).toContain("couldn't fetch the copy");
    });
  });
});
