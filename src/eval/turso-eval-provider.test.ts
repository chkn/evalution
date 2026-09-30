// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { runEvalMigrations } from "./db/migrate.ts";
import type { EvalChangeEvent, NewEvalDefinition } from "./eval-types.ts";
import { LocalEvalProvider } from "./local-eval-provider.ts";
import { TursoEvalProvider } from "./turso-eval-provider.ts";

const clients: Database[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
});

async function makeProvider(): Promise<TursoEvalProvider> {
  const client = await connect({ path: ":memory:", url: () => null });
  clients.push(client);
  await runEvalMigrations(drizzle({ client }));
  return new TursoEvalProvider({ client });
}

const def: NewEvalDefinition = {
  name: "Plans tasks",
  prompt: { id: "odin" },
  dataset: { providerId: "local-datasets", id: "tickets" },
  inputs: {
    functionInputs: { title: { kind: "dataset", field: "0" } },
    executeInputs: {},
  },
  checks: [
    {
      id: "c1",
      uri: "evalution/checks#outputContains",
      args: {
        text: {
          kind: "value",
          value: { kind: "primitive", value: "ok" },
        },
      },
    },
    { id: "c2", uri: "checks.ts#score", label: "Score", args: {} },
  ],
};

describe("TursoEvalProvider", () => {
  it("creates, reads, updates and deletes an eval", async () => {
    const provider = await makeProvider();
    const events: EvalChangeEvent[] = [];
    provider.watch(e => events.push(e));

    const created = await provider.createEval(def);
    expect(created.id).toMatch(/^eval_/);
    expect(await provider.getEval(created.id)).toEqual(created);

    const updated = await provider.updateEval(created.id, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.checks).toEqual(def.checks);
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);

    const [summary] = await provider.listEvals();
    expect(summary).toMatchObject({
      id: created.id,
      name: "Renamed",
      checkCount: 2,
    });
    expect(summary!.lastRun).toBeUndefined();

    await provider.deleteEval(created.id);
    expect(await provider.getEval(created.id)).toBeUndefined();
    expect(events.map(e => e.type)).toEqual(["add", "update", "remove"]);
  });

  it("rejects updating an eval that doesn't exist", async () => {
    const provider = await makeProvider();
    await expect(provider.updateEval("nope", { name: "x" })).rejects.toThrow(
      /not found/,
    );
  });

  it("records runs and results, and counts them", async () => {
    const provider = await makeProvider();
    const evalDef = await provider.createEval(def);
    const run = await provider.createRun(evalDef.id, {
      definition: evalDef,
      arms: [{ id: "a0", label: "Working tree", spec: { kind: "head" } }],
      dirty: true,
      concurrency: 4,
      total: 2,
    });
    expect(run).toMatchObject({ status: "running", drifted: false });

    await provider.recordRowResult({
      runId: run.id,
      armId: "a0",
      rowId: "r1",
      sample: 0,
      rowIndex: 0,
      rowCells: {},
      traceProviderId: "local-db",
      traceId: "t1",
      status: "ok",
      costUsd: 0.01,
    });
    await provider.recordCheckResults([
      {
        runId: run.id,
        armId: "a0",
        rowId: "r1",
        sample: 0,
        checkId: "c1",
        outcome: "pass",
      },
      {
        runId: run.id,
        armId: "a0",
        rowId: "r1",
        sample: 0,
        checkId: "c2",
        outcome: "fail",
        score: 0.2,
        message: "low",
        details: { expected: 1 },
      },
    ]);

    let [summary] = await provider.listRuns(evalDef.id);
    expect(summary).toMatchObject({
      status: "running",
      done: 1,
      total: 2,
      counts: { pass: 1, fail: 1, error: 0, skipped: 0, scored: 0 },
    });

    await provider.finishRun(run.id, "done", { drifted: true });
    [summary] = await provider.listRuns(evalDef.id);
    expect(summary).toMatchObject({ status: "done", drifted: true });
    expect(summary!.endedAt).toBeDefined();

    const [listed] = await provider.listEvals();
    expect(listed!.lastRun).toMatchObject({ id: run.id, done: 1 });

    const results = await provider.listResults(run.id);
    expect(results.rows).toHaveLength(1);
    expect(results.rows[0]).toMatchObject({ costUsd: 0.01, traceId: "t1" });
    expect(results.checks.find(c => c.checkId === "c2")).toMatchObject({
      score: 0.2,
      details: { expected: 1 },
    });

    expect(await provider.resultsForTrace("local-db", "t1")).toEqual([
      expect.objectContaining({
        checkId: "c1",
        evalName: "Plans tasks",
        checkLabel: "evalution/checks#outputContains",
        armLabel: "Working tree",
      }),
      expect.objectContaining({ checkId: "c2", checkLabel: "Score" }),
    ]);
    expect(await provider.resultsForTrace("local-db", "other")).toEqual([]);

    // Deleting the eval removes its runs and results.
    await provider.deleteEval(evalDef.id);
    expect(await provider.getRun(run.id)).toBeUndefined();
    expect(await provider.listResults(run.id)).toEqual({
      rows: [],
      checks: [],
    });
  });

  it("marks runs left running as errors, leaving finished ones", async () => {
    const provider = await makeProvider();
    const evalDef = await provider.createEval(def);
    const newRun = () =>
      provider.createRun(evalDef.id, {
        definition: evalDef,
        arms: [],
        dirty: false,
        concurrency: 1,
        total: 0,
      });
    const cutOff = await newRun();
    const finished = await newRun();
    await provider.finishRun(finished.id, "done");
    const events: string[] = [];
    provider.watch(e => events.push(`${e.type}:${e.runId}`));

    expect(await provider.interruptRuns()).toBe(1);
    expect(await provider.getRun(cutOff.id)).toMatchObject({
      status: "error",
      endedAt: expect.any(Number),
    });
    expect((await provider.getRun(finished.id))?.status).toBe("done");
    expect(events).toEqual([`update:${cutOff.id}`]);
    // The sidebar's summary no longer shows a run in flight.
    const [summary] = await provider.listEvals();
    expect(summary.lastRun?.status).not.toBe("running");
  });

  it("refuses a run of an eval that doesn't exist", async () => {
    const provider = await makeProvider();
    await expect(
      provider.createRun("nope", {
        definition: { ...def, id: "nope", createdAt: 0, updatedAt: 0 },
        arms: [],
        dirty: false,
        concurrency: 1,
        total: 0,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("LocalEvalProvider", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tmpDirs.splice(0))
      await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates nothing until the first write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-evals-"));
    tmpDirs.push(dir);
    const provider = new LocalEvalProvider({
      path: path.join(dir, "evals", "evals.db"),
    });
    const events: EvalChangeEvent[] = [];
    provider.watch(e => events.push(e));

    expect(await provider.listEvals()).toEqual([]);
    expect(await provider.resultsForTrace("p", "t")).toEqual([]);
    await expect(fs.access(path.join(dir, "evals"))).rejects.toThrow();

    const created = await provider.createEval(def);
    expect((await provider.listEvals()).map(e => e.id)).toEqual([created.id]);
    expect(events).toEqual([{ type: "add", evalId: created.id }]);
    expect(
      await fs.readFile(path.join(dir, "evals", ".gitignore"), "utf8"),
    ).toBe("*\n");
  });
});
