// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { trace } from "@opentelemetry/api";
import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { runDatasetMigrations } from "../dataset/db/migrate.ts";
import { TursoDatasetProvider } from "../dataset/turso-dataset-provider.ts";
import type {
  PromptProvider,
  PromptVariations,
} from "../prompt/prompt-provider.ts";
import type {
  ExecutionInput,
  NormalizedPrompt,
  PropDefinition,
} from "../shared/types.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
import { runEvalMigrations } from "./db/migrate.ts";
import {
  EvalRunner,
  type EvalRunnerOptions,
  EvalRunRefusedError,
} from "./eval-runner.ts";
import type { EvalCheck, EvalRunProgress } from "./eval-types.ts";
import { TursoEvalProvider } from "./turso-eval-provider.ts";

const clients: Database[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
});

async function client(migrate: (c: Database) => Promise<void>) {
  const c = await connect({ path: ":memory:", url: () => null });
  clients.push(c);
  await migrate(c);
  return c;
}

const string = (name: string, optional = false): PropDefinition => ({
  name,
  optional,
  type: { kind: "primitive", syntax: "string", base: "string" },
});

const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

const PROMPT: NormalizedPrompt = {
  id: "p#answer",
  name: "answer",
  functionParameters: [string("question")],
  style: "chat",
  modelEditable: true,
  systemEditable: true,
  messages: [],
  messagesEditable: true,
  modelParameters: [],
};

/**
 * A provider whose `execute` answers `ANSWER: <question>` on one LLM span,
 * recorded to `traces` the way a telemetry ingestor would.
 */
function fakeProvider(
  traces: MemoryTraceProvider,
  options: {
    fail?: (question: string) => boolean;
    leaveOpen?: boolean;
    /** Never settles the generation for these questions — a hung SDK call. */
    hang?: (question: string) => boolean;
    variations?: PromptVariations;
  } = {},
): PromptProvider & { calls: { question: string; variation?: string }[] } {
  const calls: { question: string; variation?: string }[] = [];
  return {
    id: "fake",
    calls,
    variations: options.variations,
    async getAllPrompts() {
      return [PROMPT];
    },
    async getPrompt() {
      return PROMPT;
    },
    async execute(ref, [question], opts) {
      const traceId = opts!.traceId!;
      calls.push({
        question,
        ...(typeof ref !== "string" &&
          ref.variation && { variation: ref.variation }),
      });
      const start = Date.now();
      const root = {
        id: `${traceId}:root`,
        traceId,
        name: "answer",
        kind: "LLM" as const,
        startTime: start,
      };
      await traces.recordSpanStart(root);
      if (options.hang?.(question)) return {};
      setTimeout(async () => {
        if (!options.leaveOpen) {
          const failed = options.fail?.(question);
          await traces.recordSpanEnd({
            ...root,
            endTime: start + 5,
            status: failed ? "error" : "ok",
            ...(failed && { errorMessage: "model exploded" }),
            llm: {
              output: `ANSWER: ${question}`,
              cost: { prompt: 0.001, completion: 0.002 },
            },
          });
        }
        opts!.onSettled?.();
      }, 1);
      return typeof ref !== "string" && ref.variation
        ? { variation: ref.variation }
        : {};
    },
  };
}

const contains = (id: string, field: string): EvalCheck => ({
  id,
  uri: "evalution/checks#outputContains",
  args: { text: { kind: "dataset", field } },
});

async function setUp(
  options: {
    rows?: Record<string, ExecutionInput>[];
    checks?: EvalCheck[];
    inputs?: Record<string, ExecutionInput>;
    provider?: Parameters<typeof fakeProvider>[1];
    runner?: Partial<EvalRunnerOptions>;
  } = {},
) {
  const traces = new MemoryTraceProvider({ id: "mem" });
  const prompts = fakeProvider(traces, options.provider);
  const datasets = new TursoDatasetProvider({
    client: await client(c => runDatasetMigrations(drizzle({ client: c }))),
    id: "ds",
  });
  const evals = new TursoEvalProvider({
    client: await client(c => runEvalMigrations(drizzle({ client: c }))),
  });
  const dataset = await datasets.createDataset({
    name: "Questions",
    fields: [{ def: string("question") }, { def: string("expected") }],
  });
  await datasets.addRows(
    dataset.id,
    (
      options.rows ?? [
        { "0": text("cats"), "1": text("cats") },
        { "0": text("dogs"), "1": text("birds") },
      ]
    ).map(cells => ({ cells })),
  );
  const def = await evals.createEval({
    name: "Answers",
    prompt: { id: PROMPT.id, providerId: "fake" },
    dataset: { providerId: "ds", id: dataset.id },
    inputs: {
      functionInputs: options.inputs ?? {
        question: { kind: "dataset", field: "0" },
      },
      executeInputs: {},
    },
    checks: options.checks ?? [contains("c1", "1")],
  });
  const progress: EvalRunProgress[] = [];
  const runner = new EvalRunner({
    promptProviders: new Map([["fake", prompts]]),
    datasetProviders: new Map([["ds", datasets]]),
    traceProvider: traces,
    traceProviderId: "mem",
    tracer: trace.getTracer("test"),
    resolvePrompt: p => ({ providerId: p.providerId!, promptId: p.id }),
    onProgress: p => progress.push(p),
    traceWait: { intervalMs: 5, timeoutMs: 1000 },
    ...options.runner,
  });
  return { runner, evals, def, prompts, progress };
}

describe("EvalRunner", () => {
  it("runs every row, judges it, and records the results", async () => {
    const { runner, evals, def, progress } = await setUp();
    const run = await runner.start(evals, def.id);
    expect(run).toMatchObject({ status: "running", total: 2, dirty: false });
    await runner.finished(run.id);

    const results = await evals.listResults(run.id);
    expect(results.rows).toHaveLength(2);
    expect(results.rows[0]).toMatchObject({
      rowIndex: 0,
      status: "ok",
      traceProviderId: "mem",
      costUsd: 0.003,
      durationMs: 5,
    });
    const outcomes = results.rows.map(
      r => results.checks.find(c => c.rowId === r.rowId)?.outcome,
    );
    expect(outcomes).toEqual(["pass", "fail"]);

    const [summary] = await evals.listRuns(def.id);
    expect(summary).toMatchObject({
      status: "done",
      done: 2,
      counts: { pass: 1, fail: 1 },
    });
    expect(progress.at(-1)).toMatchObject({
      status: "done",
      done: 2,
      total: 2,
      counts: { pass: 1, fail: 1 },
    });
  });

  it("lists the trace's check results", async () => {
    const { runner, evals, def } = await setUp();
    const run = await runner.start(evals, def.id);
    await runner.finished(run.id);
    const { rows } = await evals.listResults(run.id);
    expect(await evals.resultsForTrace("mem", rows[0]!.traceId!)).toEqual([
      expect.objectContaining({ outcome: "pass", evalName: "Answers" }),
    ]);
  });

  it("refuses to start an eval with problems, recording nothing", async () => {
    const { runner, evals, def } = await setUp({ inputs: {} });
    const refused = runner.start(evals, def.id);
    await expect(refused).rejects.toBeInstanceOf(EvalRunRefusedError);
    await expect(refused).rejects.toMatchObject({
      problems: ["Input 'question' is required but unbound"],
    });
    expect(await evals.listRuns(def.id)).toEqual([]);
  });

  it("errors a row that leaves a required slot's cell empty, running nothing", async () => {
    const { runner, evals, def, prompts } = await setUp({
      rows: [{ "1": text("x") }],
    });
    const run = await runner.start(evals, def.id);
    await runner.finished(run.id);
    const { rows, checks } = await evals.listResults(run.id);
    expect(rows[0]).toMatchObject({
      status: "error",
      error: "Row 1 has no 'question' for required input 'question'",
    });
    expect(checks.map(c => c.outcome)).toEqual(["skipped"]);
    expect(prompts.calls).toEqual([]);
  });

  it("skips checks on a failed run unless they run on error", async () => {
    const { runner, evals, def } = await setUp({
      provider: { fail: q => q === "dogs" },
    });
    const run = await runner.start(evals, def.id);
    await runner.finished(run.id);
    const { rows, checks } = await evals.listResults(run.id);
    const failed = rows.find(r => r.status === "error")!;
    expect(failed.error).toBe("model exploded");
    expect(checks.find(c => c.rowId === failed.rowId)?.outcome).toBe("skipped");
  });

  it("reports an invalid check input as the check's error, not a fail", async () => {
    const { runner, evals, def } = await setUp({
      checks: [
        {
          id: "c1",
          uri: "evalution/checks#maxCost",
          args: { usd: text("cheap") },
        },
      ],
    });
    const run = await runner.start(evals, def.id);
    await runner.finished(run.id);
    const { checks } = await evals.listResults(run.id);
    expect(checks[0]).toMatchObject({
      outcome: "error",
      message: expect.stringMatching(/invalid value for 'usd'/),
    });
  });

  it("scores against a threshold", async () => {
    const { runner, evals, def } = await setUp({
      checks: [
        {
          id: "c1",
          uri: "evalution/checks#maxCost",
          args: {
            usd: { kind: "value", value: { kind: "primitive", value: 0.01 } },
          },
        },
      ],
    });
    const run = await runner.start(evals, def.id);
    await runner.finished(run.id);
    const { checks } = await evals.listResults(run.id);
    expect(checks.map(c => c.outcome)).toEqual(["pass", "pass"]);
  });

  it("flags a trace that doesn't finish arriving, and runs the checks anyway", async () => {
    const { runner, evals, def } = await setUp({
      provider: { leaveOpen: true },
      rows: [{ "0": text("a"), "1": text("a") }],
      runner: { traceWait: { intervalMs: 5, timeoutMs: 30 } },
    });
    const run = await runner.start(evals, def.id);
    await runner.finished(run.id);
    const { rows, checks } = await evals.listResults(run.id);
    expect(rows[0]).toMatchObject({ traceIncomplete: true });
    expect(checks[0]).toMatchObject({
      outcome: "error",
      message: expect.stringMatching(/didn't finish arriving/),
    });
  });

  it("skips the queued rows of a cancelled run", async () => {
    const { runner, evals, def } = await setUp({
      rows: [
        { "0": text("a"), "1": text("a") },
        { "0": text("b"), "1": text("b") },
        { "0": text("c"), "1": text("c") },
      ],
    });
    const run = await runner.start(evals, def.id, { concurrency: 1 });
    expect(runner.cancel(run.id)).toBe(true);
    await runner.finished(run.id);
    const { rows } = await evals.listResults(run.id);
    expect(rows.map(r => r.status)).toEqual(["ok", "skipped", "skipped"]);
    const [summary] = await evals.listRuns(def.id);
    expect(summary).toMatchObject({ status: "cancelled", done: 3 });
    expect(runner.cancel(run.id)).toBe(false);
  });

  it("runs variations as arms, failing a conflicted one alone", async () => {
    const rebased: string[] = [];
    const variations = {
      async get(id: string) {
        return { id, names: [`named-${id}`] };
      },
      async rebase(id: string) {
        rebased.push(id);
        return id === "bad"
          ? { ok: false, conflicts: [{ field: "system" }] }
          : { ok: true, variation: { id: `${id}-rebased` } };
      },
    } as unknown as PromptVariations;
    const { runner, evals, def, prompts } = await setUp({
      provider: { variations },
      rows: [{ "0": text("a"), "1": text("a") }],
    });
    const run = await runner.start(evals, def.id, {
      arms: [
        { kind: "head" },
        { kind: "variation", variation: "v1" },
        { kind: "variation", variation: "bad" },
        { kind: "wip", variation: "w" },
      ],
    });
    expect(run.total).toBe(3);
    expect(run.arms.map(a => [a.label, a.error])).toEqual([
      ["Working tree", undefined],
      ["named-v1", undefined],
      ["named-bad", "The variation conflicts with the working tree"],
      ["Unsaved edits", undefined],
    ]);
    await runner.finished(run.id);
    expect(rebased.sort()).toEqual(["bad", "v1", "w"]);
    expect(prompts.calls.map(c => c.variation ?? "head").sort()).toEqual([
      "head",
      "v1-rebased",
      "w-rebased",
    ]);
    const { rows } = await evals.listResults(run.id);
    expect(rows.find(r => r.armId === "a1")?.variation).toBe("v1-rebased");
  });

  it("marks a run drifted when a row ran on another version", async () => {
    const { runner, evals, def, prompts } = await setUp({
      rows: [{ "0": text("a"), "1": text("a") }],
    });
    (prompts as any).versions = {
      async head() {
        return { commit: { id: "c1", time: 0 }, clean: true };
      },
    };
    const run = await runner.start(evals, def.id);
    expect(run).toMatchObject({ startVersion: "c1", dirty: false });
    await runner.finished(run.id);
    // The fake records no version, so the row can't have run on c1.
    const [summary] = await evals.listRuns(def.id);
    expect(summary).toMatchObject({ drifted: true });
  });

  describe("a row that never settles", () => {
    it("errors after the row timeout, and the run still finishes", async () => {
      const { runner, evals, def } = await setUp({
        provider: { hang: q => q === "dogs" },
        runner: { rowTimeoutMs: 50 },
      });
      const run = await runner.start(evals, def.id);
      await runner.finished(run.id);

      expect((await evals.getRun(run.id))?.status).toBe("done");
      const { rows, checks } = await evals.listResults(run.id);
      const hung = rows.find(r => r.rowIndex === 1)!;
      expect(hung).toMatchObject({
        status: "error",
        error: "The prompt didn't finish within 50ms",
      });
      expect(checks.find(c => c.rowId === hung.rowId)?.outcome).toBe("skipped");
    });

    it("stops waiting when the run is cancelled", async () => {
      const { runner, evals, def, prompts } = await setUp({
        provider: { hang: () => true },
        runner: { traceWait: { intervalMs: 5, timeoutMs: 20 } },
      });
      const run = await runner.start(evals, def.id, { concurrency: 1 });
      while (prompts.calls.length === 0)
        await new Promise(r => setTimeout(r, 5));
      runner.cancel(run.id);
      await runner.finished(run.id);

      expect((await evals.getRun(run.id))?.status).toBe("cancelled");
      const { rows } = await evals.listResults(run.id);
      expect(rows.map(r => r.error)).toEqual([
        "The run was cancelled before this row finished",
        "The run was cancelled",
      ]);
      expect(prompts.calls).toHaveLength(1);
    });
  });

  it("stops every worker once one fails to record, and marks the run an error", async () => {
    const { runner, evals, def, prompts } = await setUp({
      rows: [
        { "0": text("a"), "1": text("a") },
        { "0": text("b"), "1": text("b") },
        { "0": text("c"), "1": text("c") },
      ],
    });
    evals.recordRowResult = async () => {
      throw new Error("disk full");
    };
    const run = await runner.start(evals, def.id, { concurrency: 1 });
    await runner.finished(run.id);

    expect((await evals.getRun(run.id))?.status).toBe("error");
    expect(prompts.calls).toHaveLength(1);
  });
});
