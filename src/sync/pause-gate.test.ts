// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { PauseGate } from "./pause-gate.ts";

/** A promise and the function that settles it. */
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("PauseGate", () => {
  it("runs operations side by side", async () => {
    const gate = new PauseGate();
    const first = deferred();
    const order: string[] = [];

    const a = gate.run(async () => {
      await first.promise;
      order.push("a");
    });
    const b = gate.run(async () => {
      order.push("b");
    });
    await b;
    first.resolve();
    await a;

    expect(order).toEqual(["b", "a"]);
  });

  it("pauses once the operations under way finish, and holds new ones until it's done", async () => {
    const gate = new PauseGate();
    const running = deferred();
    const paused = deferred();
    const order: string[] = [];

    const before = gate.run(async () => {
      await running.promise;
      order.push("before");
    });
    const pause = gate.pause(async () => {
      order.push("pause");
      await paused.promise;
      order.push("resume");
    });
    const after = gate.run(async () => {
      order.push("after");
    });
    await tick();
    expect(order).toEqual([]);
    expect(gate.isPaused).toBe(true);

    running.resolve();
    await tick();
    expect(order).toEqual(["before", "pause"]);

    paused.resolve();
    await Promise.all([before, pause, after]);
    expect(order).toEqual(["before", "pause", "resume", "after"]);
    expect(gate.isPaused).toBe(false);
  });

  it("lets operations run again after a pause fails", async () => {
    const gate = new PauseGate();

    await expect(
      gate.pause(async () => {
        throw new Error("swap failed");
      }),
    ).rejects.toThrow("swap failed");

    expect(await gate.run(async () => "ran")).toBe("ran");
  });

  it("runs one pause at a time", async () => {
    const gate = new PauseGate();
    const first = deferred();
    const order: string[] = [];

    const a = gate.pause(async () => {
      await first.promise;
      order.push("a");
    });
    const b = gate.pause(async () => {
      order.push("b");
    });
    await tick();
    first.resolve();
    await Promise.all([a, b]);

    expect(order).toEqual(["a", "b"]);
  });
});
