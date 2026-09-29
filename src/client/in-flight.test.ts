// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { createInFlight } from "./in-flight";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createInFlight", () => {
  it("settles at once when nothing is pending", async () => {
    const inFlight = createInFlight();
    await inFlight.settled();
    expect(inFlight.size).toBe(0);
  });

  it("waits for everything tracked, including what's tracked while waiting", async () => {
    const inFlight = createInFlight();
    const first = deferred();
    const second = deferred();
    inFlight.track(first.promise);

    let settled = false;
    const waiting = inFlight.settled().then(() => (settled = true));
    inFlight.track(second.promise);
    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    second.resolve();
    await waiting;
    expect(inFlight.size).toBe(0);
  });

  it("doesn't reject when a tracked promise does", async () => {
    const inFlight = createInFlight();
    const failing = deferred();
    inFlight.track(failing.promise).catch(() => {});
    failing.reject(new Error("boom"));
    await expect(inFlight.settled()).resolves.toBeUndefined();
    expect(inFlight.size).toBe(0);
  });
});
