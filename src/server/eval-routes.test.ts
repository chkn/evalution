// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { trace } from "@opentelemetry/api";
import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { runDatasetMigrations } from "../dataset/db/migrate.ts";
import { TursoDatasetProvider } from "../dataset/turso-dataset-provider.ts";
import { runEvalMigrations } from "../eval/db/migrate.ts";
import { TursoEvalProvider } from "../eval/turso-eval-provider.ts";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import type { NormalizedPrompt, SSEData } from "../shared/types.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
import { createApiContext } from "./api-context.ts";
import { setupRoutes } from "./api-routes.ts";

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

const PROMPT: NormalizedPrompt = {
  id: "p#answer",
  name: "answer",
  functionParameters: [
    {
      name: "question",
      optional: false,
      type: { kind: "primitive", syntax: "string", base: "string" },
    },
  ],
  style: "chat",
  modelEditable: true,
  systemEditable: true,
  messages: [],
  messagesEditable: true,
  modelParameters: [],
};

async function makeApp() {
  const traces = new MemoryTraceProvider({ id: "mem" });
  const prompts: PromptProvider = {
    id: "fake",
    async getAllPrompts() {
      return [PROMPT];
    },
    async getPrompt() {
      return PROMPT;
    },
    async execute(_ref, [question], opts) {
      const root = {
        id: `${opts!.traceId}:root`,
        traceId: opts!.traceId!,
        name: "answer",
        kind: "LLM" as const,
        startTime: 1,
      };
      await traces.recordSpanStart(root);
      await traces.recordSpanEnd({
        ...root,
        endTime: 2,
        status: "ok",
        llm: { output: `ANSWER: ${question}` },
      });
      opts!.onSettled?.();
    },
  };
  const datasets = new TursoDatasetProvider({
    client: await client(c => runDatasetMigrations(drizzle({ client: c }))),
    id: "ds",
  });
  const evals = new TursoEvalProvider({
    client: await client(c => runEvalMigrations(drizzle({ client: c }))),
    id: "ev",
  });
  const dataset = await datasets.createDataset({
    name: "Questions",
    fields: [{ def: PROMPT.functionParameters[0]! }],
  });
  await datasets.addRows(dataset.id, [
    {
      cells: {
        "0": { kind: "value", value: { kind: "primitive", value: "cats" } },
      },
    },
  ]);
  const promptRegistry = new PromptRegistry();
  const events: SSEData[] = [];
  const app = new Hono();
  setupRoutes({
    app,
    context: createApiContext({
      promptProviders: new Map([["fake", prompts]]),
      traceProviders: new Map([["mem", traces]]),
      datasetProviders: new Map([["ds", datasets]]),
      evalProviders: new Map([["ev", evals]]),
      promptRegistry,
      rootPath: "/demo",
      tracer: trace.getTracer("test"),
      defaultTraceProviderId: "mem",
    }),
    hotReloadSubscribers: new Set([(e: SSEData) => void events.push(e)]),
    hasConfig: true,
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { call, dataset, events };
}

const newEval = (datasetId: string, overrides: object = {}) => ({
  name: "Answers",
  prompt: { id: "p#answer", providerId: "fake" },
  dataset: { providerId: "ds", id: datasetId },
  inputs: {
    functionInputs: { question: { kind: "dataset", field: "0" } },
  },
  checks: [
    {
      id: "c1",
      uri: "evalution/checks#outputContains",
      args: { text: { kind: "input", half: "function", path: "question" } },
    },
  ],
  ...overrides,
});

/** Polls `GET` for a run until it's no longer running. */
async function awaitRun(
  call: Awaited<ReturnType<typeof makeApp>>["call"],
  runId: string,
) {
  for (let i = 0; i < 100; i++) {
    const res = await call("GET", `/api/eval-runs/ev/${runId}`);
    if (!res.body.running && res.body.run.status !== "running") return res;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error("run never finished");
}

describe("eval routes", () => {
  it("creates, reads, updates, lists and deletes an eval", async () => {
    const { call, dataset, events } = await makeApp();
    expect((await call("GET", "/api/eval-providers")).body).toEqual([
      { id: "ev", displayName: "Evals" },
    ]);

    const created = await call("POST", "/api/evals/ev", newEval(dataset.id));
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await call("GET", `/api/evals/ev/${id}`)).body).toMatchObject({
      name: "Answers",
      inputs: { executeInputs: {} },
    });
    const patched = await call("PATCH", `/api/evals/ev/${id}`, {
      name: "Renamed",
    });
    expect(patched.body.name).toBe("Renamed");
    expect((await call("GET", "/api/evals")).body).toEqual([
      expect.objectContaining({ providerId: "ev", id, name: "Renamed" }),
    ]);

    expect((await call("DELETE", `/api/evals/ev/${id}`)).status).toBe(204);
    expect((await call("GET", `/api/evals/ev/${id}`)).status).toBe(404);
    expect(events.filter(e => e.type === "eval-changed")).toHaveLength(3);
  });

  it.each([
    ["a missing name", { name: "" }],
    ["a malformed binding", { inputs: { functionInputs: { question: "x" } } }],
    [
      "a repeated check id",
      {
        checks: [
          { id: "a", uri: "x#y" },
          { id: "a", uri: "x#z" },
        ],
      },
    ],
  ])("rejects %s with a 400", async (_label, overrides) => {
    const { call, dataset } = await makeApp();
    const res = await call(
      "POST",
      "/api/evals/ev",
      newEval(dataset.id, overrides),
    );
    expect(res.status).toBe(400);
  });

  it("runs an eval, streams progress, and serves the results", async () => {
    const { call, dataset, events } = await makeApp();
    const { body: def } = await call(
      "POST",
      "/api/evals/ev",
      newEval(dataset.id),
    );
    const started = await call("POST", `/api/evals/ev/${def.id}/runs`, {
      concurrency: 2,
    });
    expect(started.status).toBe(201);

    const { body } = await awaitRun(call, started.body.id);
    expect(body.run.status).toBe("done");
    expect(body.results.checks.map((c: any) => c.outcome)).toEqual(["pass"]);
    expect(events.filter(e => e.type === "eval-run").at(-1)).toMatchObject({
      status: "done",
      done: 1,
      total: 1,
      counts: { pass: 1 },
    });

    const runs = await call("GET", `/api/evals/ev/${def.id}/runs`);
    expect(runs.body).toEqual([expect.objectContaining({ done: 1 })]);

    const traceId = body.results.rows[0].traceId;
    const checks = await call(
      "GET",
      `/api/traces/mem/${traceId}/check-results`,
    );
    expect(checks.body).toEqual([
      expect.objectContaining({ providerId: "ev", outcome: "pass" }),
    ]);

    // Over: nothing to cancel.
    expect(
      (await call("POST", `/api/eval-runs/ev/${started.body.id}/cancel`))
        .status,
    ).toBe(409);
  });

  it("deletes a run with its results", async () => {
    const { call, dataset } = await makeApp();
    const { body: def } = await call(
      "POST",
      "/api/evals/ev",
      newEval(dataset.id),
    );
    const { body: run } = await call("POST", `/api/evals/ev/${def.id}/runs`);
    await awaitRun(call, run.id);

    expect((await call("DELETE", `/api/eval-runs/ev/${run.id}`)).status).toBe(
      204,
    );
    expect((await call("GET", `/api/eval-runs/ev/${run.id}`)).status).toBe(404);
    expect((await call("GET", `/api/evals/ev/${def.id}/runs`)).body).toEqual(
      [],
    );
    // The eval itself stays.
    expect((await call("GET", `/api/evals/ev/${def.id}`)).status).toBe(200);
  });

  it("refuses to run an eval with problems, listing them", async () => {
    const { call, dataset } = await makeApp();
    const { body: def } = await call(
      "POST",
      "/api/evals/ev",
      newEval(dataset.id, { inputs: {} }),
    );
    const res = await call("POST", `/api/evals/ev/${def.id}/runs`, {});
    expect(res.status).toBe(400);
    expect(res.body.problems).toEqual([
      "Input 'question' is required but unbound",
    ]);
  });

  it("lists every prompt provider's checks", async () => {
    const { call } = await makeApp();
    const { body } = await call("GET", "/api/checks");
    expect(body).toEqual([
      {
        providerId: "fake",
        checks: expect.arrayContaining([
          expect.objectContaining({ uri: "evalution/checks#outputContains" }),
        ]),
      },
    ]);
  });

  it("adds a dataset field from a check's parameter", async () => {
    const { call, dataset } = await makeApp();
    const res = await call("POST", `/api/datasets/ds/${dataset.id}/fields`, {
      from: {
        providerId: "fake",
        checkUri: "evalution/checks#outputContains",
        path: "text",
      },
      name: "expected",
    });
    expect(res.status).toBe(201);
    expect(res.body.def).toMatchObject({ name: "expected" });
  });
});

describe("GET /api/prompt-providers/:providerId/head", () => {
  it("says a provider without versions isn't versioned", async () => {
    const { call } = await makeApp();
    expect((await call("GET", "/api/prompt-providers/fake/head")).body).toEqual(
      { versioned: false, clean: false },
    );
    expect((await call("GET", "/api/prompt-providers/nope/head")).status).toBe(
      404,
    );
  });
});
