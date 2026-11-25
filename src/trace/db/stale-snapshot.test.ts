// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { isStaleSnapshotError, transaction } from "./stale-snapshot.ts";

const stale = () =>
  new Error("Failed query: insert into ...", {
    cause: new Error(
      "step failed: Database snapshot is stale. You must rollback and retry the whole transaction.",
    ),
  });

/** A stand-in for a Drizzle database whose transactions fail as `failures` says. */
function fakeDb(failures: Array<() => Error>) {
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    async transaction<R>(fn: (tx: "tx") => Promise<R>): Promise<R> {
      const failure = failures[attempts++];
      if (failure) throw failure();
      return fn("tx");
    },
  };
}

describe("isStaleSnapshotError", () => {
  it("finds the stale snapshot in a wrapped cause", () => {
    expect(isStaleSnapshotError(stale())).toBe(true);
  });

  it("is false for other errors, and for non-errors", () => {
    expect(isStaleSnapshotError(new Error("database is locked"))).toBe(false);
    expect(isStaleSnapshotError("snapshot is stale")).toBe(false);
    expect(isStaleSnapshotError(undefined)).toBe(false);
  });
});

describe("transaction", () => {
  it("runs the transaction again after a stale snapshot", async () => {
    const db = fakeDb([stale, stale]);
    await expect(transaction(db, async tx => `${tx} done`)).resolves.toBe(
      "tx done",
    );
    expect(db.attempts).toBe(3);
  });

  it("rethrows any other error without running it again", async () => {
    const db = fakeDb([() => new Error("UNIQUE constraint failed")]);
    await expect(transaction(db, async () => "done")).rejects.toThrow(
      "UNIQUE constraint failed",
    );
    expect(db.attempts).toBe(1);
  });

  it("gives up once a snapshot has gone stale on every attempt", async () => {
    const db = fakeDb(Array(10).fill(stale));
    await expect(transaction(db, async () => "done")).rejects.toSatisfy(
      isStaleSnapshotError,
    );
    expect(db.attempts).toBe(5);
  });
});
