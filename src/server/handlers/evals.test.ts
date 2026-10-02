// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { EvalProvider } from "../../eval/eval-provider.ts";
import type { EvalRunner } from "../../eval/eval-runner.ts";
import { handleDeleteRun } from "./evals.ts";

describe("handleDeleteRun", () => {
  /** A runner with `runId` in flight until `finish` is called. */
  function runnerWith(runId: string) {
    const steps: string[] = [];
    let finish = () => {};
    const finished = new Promise<void>(r => {
      finish = r;
    });
    let running = true;
    const runner = {
      cancel(id: string) {
        if (id !== runId || !running) return false;
        steps.push("cancel");
        return true;
      },
      finished: async () => {
        await finished;
        running = false;
      },
    } as Partial<EvalRunner> as EvalRunner;
    const provider = {
      async deleteRun(id: string) {
        steps.push(`delete ${id}`);
      },
    } as Partial<EvalProvider> as EvalProvider;
    return { runner, provider, steps, finish };
  }

  it("cancels a run in flight, and deletes it only once it has finished", async () => {
    const { runner, provider, steps, finish } = runnerWith("run_1");
    const deleting = handleDeleteRun(runner, provider, "run_1");
    await new Promise(r => setTimeout(r, 0));
    // Rows still in flight would otherwise be recorded after the run is gone.
    expect(steps).toEqual(["cancel"]);

    finish();
    expect(await deleting).toEqual({ status: 204, body: undefined });
    expect(steps).toEqual(["cancel", "delete run_1"]);
  });

  it("deletes a finished run at once, and works with no runner", async () => {
    const { runner, provider, steps } = runnerWith("run_1");
    expect((await handleDeleteRun(runner, provider, "run_2")).status).toBe(204);
    expect((await handleDeleteRun(undefined, provider, "run_3")).status).toBe(
      204,
    );
    expect(steps).toEqual(["delete run_2", "delete run_3"]);
  });
});
