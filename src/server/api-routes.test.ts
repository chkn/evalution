// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { runDatasetMigrations } from "../dataset/db/migrate.ts";
import { TursoDatasetProvider } from "../dataset/turso-dataset-provider.ts";
import {
  type PromptProvider,
  promptIdOf,
  VariationConflictError,
} from "../prompt/prompt-provider.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import type { ExecuteRequest, SSEData } from "../shared/types.ts";
import { runMigrations } from "../trace/db/migrate.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
import { OtlpTraceIngestor } from "../trace/otlp-trace-ingestor.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import { TursoTraceProvider } from "../trace/turso-trace-provider.ts";
import { setupRoutes } from "./api-routes.ts";

const PROVIDER_ID = "fake";
const TRACE_PROVIDER_ID = "memory";

/** Minimal fake `PromptProvider` whose `execute` is fully controlled by the test. */
function fakeProvider(
  execute: PromptProvider["execute"] = async () => {},
): PromptProvider {
  return {
    id: PROVIDER_ID,
    async getAllPrompts() {
      return [
        {
          id: "p#test",
          name: "test",
          functionParameters: [],
          style: "chat",
          modelEditable: true,
          systemEditable: true,
          messages: [],
          messagesEditable: true,
          modelParameters: [],
        },
      ];
    },
    async getPrompt(ref) {
      const id = promptIdOf(ref);
      return id === "p#test"
        ? {
            id,
            name: "test",
            functionParameters: [],
            style: "chat",
            modelEditable: true,
            systemEditable: true,
            messages: [],
            messagesEditable: true,
            modelParameters: [],
          }
        : null;
    },
    execute,
  };
}

function makeApp(
  execute?: PromptProvider["execute"],
  otlpIngestor?: OtlpTraceIngestor,
) {
  const app = new Hono();
  const promptProvider = fakeProvider(execute);
  const traceProvider = new MemoryTraceProvider({ id: TRACE_PROVIDER_ID });
  const promptProviders = new Map([[PROVIDER_ID, promptProvider]]);
  const traceProviders = new Map([[TRACE_PROVIDER_ID, traceProvider]]);
  const promptRegistry = new PromptRegistry();

  setupRoutes({
    app,
    promptProviders,
    traceProviders,
    promptRegistry,
    hotReloadSubscribers: new Set(),
    rootPath: "/demo",
    hasConfig: true,
    tracer: trace.getTracer("test"),
    defaultTraceProviderId: TRACE_PROVIDER_ID,
    otlpIngestor,
  });

  return { app, traceProvider };
}

function executeRequest(body: ExecuteRequest = { functionInputs: [] }) {
  return new Request("http://localhost/api/prompts/fake/cCN0ZXN0/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/prompts/:providerId/:id/execute", () => {
  it("returns the native traceId synchronously; the trace is created lazily by telemetry", async () => {
    // The route no longer pre-creates the trace. It hands back a trace id and
    // the telemetry ingestor creates the trace when the root span starts. Here
    // the fake `execute` stands in for that ingestor by recording a root span.
    let traceId = "";
    const { app, traceProvider } = makeApp(async (_prompt, _params, opts) => {
      traceId = opts?.traceId ?? "";
      await traceProvider.recordSpanStart({
        id: `${traceId}:root`,
        traceId,
        name: "test",
        kind: "AGENT",
        startTime: Date.now(),
      });
    });

    const res = await app.request(executeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.traceId).toBe(traceId);
    expect(body.tracerProviderId).toBe(TRACE_PROVIDER_ID);
    expect(typeof body.rootSpanId).toBe("string");
    expect(body.rootSpanId.length).toBeGreaterThan(0);

    const trace = await traceProvider.getTrace(traceId);
    expect(trace?.trace.status).toBe("running");
  });

  it("does not create a trace when execution produces no spans", async () => {
    // When `execute` fails before any span is produced, no trace is created.
    // A client that opened the returned id polls and eventually reports an
    // error — see the client `getTrace` polling tests.
    let traceId = "";
    const { app, traceProvider } = makeApp(async (_prompt, _params, opts) => {
      traceId = opts?.traceId ?? "";
    });

    await app.request(executeRequest());

    expect(await traceProvider.getTrace(traceId)).toBeUndefined();
  });

  it("returns a non-empty traceId", async () => {
    const { app } = makeApp();

    const res = await app.request(executeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.traceId).toBe("string");
    expect(body.traceId).not.toBe("");
  });

  it("mints a unique traceId per execution on the native (no-op tracer) path", async () => {
    // With no OTel provider registered the tracer is a no-op, whose span
    // context is the all-zero invalid id. The route must not hand every native
    // execution that same shared id, or all native traces collide into one.
    const { app } = makeApp();

    const a = (await (await app.request(executeRequest())).json()) as any;
    const b = (await (await app.request(executeRequest())).json()) as any;

    expect(a.traceId).not.toBe(b.traceId);
  });

  it("returns a rootSpanId matching the native ingestor's root span id", async () => {
    // The native ingestor names the root span `${traceId}:root`; the route must
    // echo that (not the no-op span's id) so the client's initial span
    // selection resolves.
    const { app } = makeApp();

    const body = (await (await app.request(executeRequest())).json()) as any;
    expect(body.rootSpanId).toBe(`${body.traceId}:root`);
  });

  it("returns 500 and records the error when execute itself rejects", async () => {
    const { app } = makeApp(async () => {
      throw new Error("boom");
    });

    const res = await app.request(executeRequest());
    expect(res.status).toBe(500);
  });

  it("resolves value inputs for a provider that implements no resolveInputs", async () => {
    // The provider contract did not change with the wire format: a provider
    // that only implements `execute` still runs, and still sees plain
    // materialized values — never an `ExecutionInput` or someone else's `uri`
    // grammar. The route's built-in fallback covers it.
    let seen: any[] | undefined;
    const { app } = makeApp(async (_prompt, params) => {
      seen = params;
    });

    const res = await app.request(
      executeRequest({
        functionInputs: [
          { kind: "value", value: { kind: "primitive", value: "Ada" } },
          {
            kind: "value",
            value: {
              kind: "object",
              properties: { n: { kind: "primitive", value: 42 } },
            },
          },
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual(["Ada", { n: 42 }]);
  });

  it("rejects a dataset input as unimplemented rather than crashing", async () => {
    // The variant is declared now so the resolver, the matching layer and the
    // panel are all built over the union before `DatasetProvider` exists. The
    // seam has to be exercised, not just present.
    const { app } = makeApp();

    const res = await app.request(
      executeRequest({
        functionInputs: [{ kind: "dataset", uri: "rows/1#col" }],
      }),
    );

    // A bad request, not a failed run: nothing was dispatched, so there is no
    // trace to carry the error and the caller has to hear it here.
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/not implemented/i);
  });

  it("hands the provider the unresolved inputs alongside the resolved values", async () => {
    // What gets recorded on the trace is the recipe, so the provider needs to
    // see it — the resolved values alone cannot be replayed.
    let opts: any;
    const { app } = makeApp(async (_prompt, _params, o) => {
      opts = o;
    });

    const functionInputs: ExecuteRequest["functionInputs"] = [
      { kind: "value", value: { kind: "primitive", value: "Ada" } },
    ];
    await app.request(executeRequest({ functionInputs }));

    expect(opts.inputs.functionInputs).toEqual(functionInputs);
  });
});

describe("POST /v1/traces (OTLP ingest)", () => {
  it("ingests a JSON OTLP export and records it on the resolved provider", async () => {
    const ingestor = new OtlpTraceIngestor();
    const { app, traceProvider } = makeApp(undefined, ingestor);
    ingestor.addSink(traceProvider);

    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "0102030405060708090a0b0c0d0e0f10",
                  spanId: "0102030405060708",
                  name: "otlp-span",
                  startTimeUnixNano: "1000000",
                  endTimeUnixNano: "2000000",
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });

    const trace = await traceProvider.getTrace(
      "0102030405060708090a0b0c0d0e0f10",
    );
    expect(trace?.trace.status).toBe("ok");
    expect(trace?.spans[0].name).toBe("otlp-span");
  });

  it("accepts exports on the /otel/v1/traces alias too", async () => {
    const ingestor = new OtlpTraceIngestor();
    const { app } = makeApp(undefined, ingestor);

    const res = await app.request("/otel/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    expect(res.status).toBe(200);
  });

  it("responds 404 when no OTLP ingestor is configured for the host", async () => {
    const { app } = makeApp(); // no otlpIngestor passed

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("responds 415 for an unrecognized content-type", async () => {
    const ingestor = new OtlpTraceIngestor();
    const { app } = makeApp(undefined, ingestor);

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "nope",
    });
    expect(res.status).toBe(415);
  });

  it("responds 400 for malformed JSON", async () => {
    const ingestor = new OtlpTraceIngestor();
    const { app } = makeApp(undefined, ingestor);

    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("annotation routes", () => {
  let dir: string;
  let client: Database;

  afterEach(async () => {
    await client?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Same wiring as `makeApp`, but with a real (Turso-backed) trace provider. */
  async function makeAnnotationsApp() {
    dir = await mkdtemp(join(tmpdir(), "evalution-annotations-routes-"));
    client = await connect({ path: join(dir, "trace.db"), url: () => null });
    await runMigrations(drizzle({ client }));
    const traceProvider = new TursoTraceProvider({
      id: TRACE_PROVIDER_ID,
      client,
    });
    await traceProvider.recordSpanStart({
      id: "t1:root",
      traceId: "t1",
      name: "root",
      kind: "LLM",
      startTime: Date.now(),
    });

    const app = new Hono();
    setupRoutes({
      app,
      promptProviders: new Map(),
      traceProviders: new Map([[TRACE_PROVIDER_ID, traceProvider]]),
      promptRegistry: new PromptRegistry(),
      hotReloadSubscribers: new Set(),
      rootPath: "/demo",
      hasConfig: true,
      tracer: trace.getTracer("test"),
      defaultTraceProviderId: TRACE_PROVIDER_ID,
    });
    return app;
  }

  it("supports the full list/create/delete cycle over HTTP", async () => {
    const app = await makeAnnotationsApp();
    const base = `/api/traces/${TRACE_PROVIDER_ID}/t1/annotations`;

    expect(await (await app.request(base)).json()).toEqual([]);

    const createRes = await app.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "issue", note: "bad output" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };
    expect(created).toMatchObject({
      kind: "issue",
      note: "bad output",
      source: "user",
    });

    const listed = await (await app.request(base)).json();
    expect(listed).toEqual([created]);

    const deleteRes = await app.request(`${base}/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(204);
    expect(await (await app.request(base)).json()).toEqual([]);
  });

  it("updates an annotation over HTTP", async () => {
    const app = await makeAnnotationsApp();
    const base = `/api/traces/${TRACE_PROVIDER_ID}/t1/annotations`;
    const created = (await (
      await app.request(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "issue", note: "bad output" }),
      })
    ).json()) as { id: string };

    const res = await app.request(`${base}/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "good" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...created, kind: "good" });
  });

  it("serves the trace query schema and runs read-only queries", async () => {
    const app = await makeAnnotationsApp();
    const schema = await app.request(
      `/api/trace-providers/${TRACE_PROVIDER_ID}/schema`,
    );
    expect(((await schema.json()) as { schema: string }).schema).toContain(
      "CREATE TABLE traces",
    );

    const query = (body: unknown) =>
      app.request(`/api/trace-providers/${TRACE_PROVIDER_ID}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await query({ sql: "SELECT id, name FROM spans" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      columns: ["id", "name"],
      rows: [{ id: "t1:root", name: "root" }],
    });
    expect((await query({ sql: "DELETE FROM spans" })).status).toBe(400);
    expect((await query({})).status).toBe(400);
    expect((await query({ sql: "SELECT 1", maxRows: 0 })).status).toBe(400);
  });

  it("reports SQL queries as unsupported for a provider without them", async () => {
    const { app } = makeApp();
    const res = await app.request(
      `/api/trace-providers/${TRACE_PROVIDER_ID}/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      },
    );
    expect(res.status).toBe(405);
  });

  it("responds 404 for an unknown trace provider", async () => {
    const app = await makeAnnotationsApp();
    const res = await app.request("/api/traces/nonexistent/t1/annotations");
    expect(res.status).toBe(404);
  });

  it("responds 400 when kind/note are missing from the create body", async () => {
    const app = await makeAnnotationsApp();
    const res = await app.request(
      `/api/traces/${TRACE_PROVIDER_ID}/t1/annotations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });

  it("responds 405 for a provider with no annotation store", async () => {
    const { app } = makeApp(); // MemoryTraceProvider-backed
    const res = await app.request(
      `/api/traces/${TRACE_PROVIDER_ID}/t1/annotations`,
    );
    expect(res.status).toBe(405);
  });
});

describe("DELETE /api/traces/:providerId/:id", () => {
  const start = (provider: MemoryTraceProvider, traceId: string) =>
    provider.recordSpanStart({
      id: `${traceId}:root`,
      traceId,
      name: "root",
      kind: "LLM",
      startTime: Date.now(),
    });

  function makeTraceApp(traceProvider: TraceProvider) {
    const app = new Hono();
    setupRoutes({
      app,
      promptProviders: new Map(),
      traceProviders: new Map([[TRACE_PROVIDER_ID, traceProvider]]),
      promptRegistry: new PromptRegistry(),
      hotReloadSubscribers: new Set(),
      rootPath: "/demo",
      hasConfig: true,
      tracer: trace.getTracer("test"),
      defaultTraceProviderId: TRACE_PROVIDER_ID,
    });
    return app;
  }

  it("deletes the trace, responding 204, then 404 on a repeat", async () => {
    const provider = new MemoryTraceProvider({ id: TRACE_PROVIDER_ID });
    await start(provider, "t1");
    await start(provider, "t2");
    const app = makeTraceApp(provider);
    const url = `/api/traces/${TRACE_PROVIDER_ID}/t1`;

    const res = await app.request(url, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await app.request(url)).status).toBe(404);
    expect(
      (
        (await (await app.request("/api/traces")).json()) as { id: string }[]
      ).map(t => t.id),
    ).toEqual(["t2"]);

    expect((await app.request(url, { method: "DELETE" })).status).toBe(404);
  });

  it("responds 404 for an unknown trace provider", async () => {
    const app = makeTraceApp(
      new MemoryTraceProvider({ id: TRACE_PROVIDER_ID }),
    );
    const res = await app.request("/api/traces/nonexistent/t1", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("responds 405 for a provider that can't delete traces", async () => {
    const readOnly: TraceProvider = {
      id: TRACE_PROVIDER_ID,
      getAllTraces: async () => [],
      getTrace: async () => ({
        trace: {
          id: "t1",
          name: "root",
          startTime: 0,
          status: "ok",
        },
        spans: [],
      }),
    };
    const res = await makeTraceApp(readOnly).request(
      `/api/traces/${TRACE_PROVIDER_ID}/t1`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(405);
  });
});

describe("GET /api/traces/:providerId/:id", () => {
  it("keeps the root span's recorded inputs when it resolves the prompt", async () => {
    // Regression: `resolveSpanPrompt` used to rebuild `span.prompt` as
    // `{ id, providerId }`, so the client never saw what a run was launched
    // with — and "Open prompt" had nothing to fill the panel from.
    const app = new Hono();
    const promptProviders = new Map([[PROVIDER_ID, fakeProvider()]]);
    const promptRegistry = new PromptRegistry();
    await promptRegistry.rebuild(promptProviders);
    const traceProvider = new MemoryTraceProvider({ id: TRACE_PROVIDER_ID });
    setupRoutes({
      app,
      promptProviders,
      traceProviders: new Map([[TRACE_PROVIDER_ID, traceProvider]]),
      promptRegistry,
      hotReloadSubscribers: new Set(),
      rootPath: "/demo",
      hasConfig: true,
      tracer: trace.getTracer("test"),
      defaultTraceProviderId: TRACE_PROVIDER_ID,
    });

    const functionInputs = [
      { kind: "value", value: { kind: "primitive", value: "Ada" } },
    ];
    await traceProvider.recordSpanStart({
      id: "t1:root",
      traceId: "t1",
      name: "test",
      kind: "AGENT",
      startTime: Date.now(),
      prompt: {
        id: "p#test",
        providerId: PROVIDER_ID,
        functionInputs,
        parameterDefinitions: [{ name: "name" }],
      },
    });

    const res = await app.request(`/api/traces/${TRACE_PROVIDER_ID}/t1`);
    const body = (await res.json()) as any;
    expect(body.spans[0].prompt).toEqual({
      id: "p#test",
      providerId: PROVIDER_ID,
      functionInputs,
      parameterDefinitions: [{ name: "name" }],
    });
  });
});

describe("dataset routes", () => {
  const DATASET_PROVIDER_ID = "datasets";
  let client: Database | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function makeDatasetApp(promptProvider = fakeProvider()) {
    client = await connect({ path: ":memory:", url: () => null });
    await runDatasetMigrations(drizzle({ client }));
    const datasetProvider = new TursoDatasetProvider({
      client,
      id: DATASET_PROVIDER_ID,
    });
    const promptProviders = new Map([[PROVIDER_ID, promptProvider]]);
    const promptRegistry = new PromptRegistry();
    await promptRegistry.rebuild(promptProviders);
    const events: SSEData[] = [];
    const app = new Hono();
    setupRoutes({
      app,
      promptProviders,
      traceProviders: new Map(),
      datasetProviders: new Map([[DATASET_PROVIDER_ID, datasetProvider]]),
      promptRegistry,
      hotReloadSubscribers: new Set([(data: SSEData) => events.push(data)]),
      rootPath: "/demo",
      hasConfig: true,
      tracer: trace.getTracer("test"),
      defaultTraceProviderId: TRACE_PROVIDER_ID,
    });
    return { app, events };
  }

  const json = (method: string, body: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const stringField = (name: string) => ({
    def: { name, type: { kind: "primitive", syntax: "string" } },
  });

  const text = (value: string) => ({
    kind: "value",
    value: { kind: "primitive", value },
  });

  async function create(
    app: Hono,
    body: unknown = { name: "Tickets", fields: [stringField("ticket")] },
  ) {
    const res = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}`,
      json("POST", body),
    );
    return { res, body: (await res.json()) as any };
  }

  it("renames and deletes fields, and queries rows with SQL", async () => {
    const { app } = await makeDatasetApp();
    const { body: dataset } = await create(app, {
      name: "Cities",
      // A field may be given as add-field takes one, as well as by `def`.
      fields: [stringField("city"), { name: "pop", type: "number" }],
    });
    expect(dataset.fields.map((f: any) => f.def.name)).toEqual(["city", "pop"]);
    const base = `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}`;
    await app.request(
      `${base}/rows`,
      json("POST", {
        rows: [
          {
            cells: {
              "0": text("Oslo"),
              "1": { kind: "value", value: { kind: "primitive", value: 700 } },
            },
          },
        ],
      }),
    );

    const renamed = await app.request(
      `${base}/fields/1`,
      json("PATCH", { name: "population" }),
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as any).def.name).toBe("population");

    const query = await app.request(
      `${base}/query`,
      json("POST", { sql: "SELECT city, population FROM rows" }),
    );
    expect(await query.json()).toEqual({
      columns: ["city", "population"],
      rows: [{ city: "Oslo", population: 700 }],
    });
    const bad = await app.request(
      `${base}/query`,
      json("POST", { sql: "SELECT nope FROM rows" }),
    );
    expect(bad.status).toBe(400);

    const deleted = await app.request(`${base}/fields/0`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const unknown = await app.request(`${base}/fields/0`, { method: "DELETE" });
    expect(unknown.status).toBe(400);
    const missing = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/nope/query`,
      json("POST", { sql: "SELECT 1" }),
    );
    expect(missing.status).toBe(404);
  });

  it("round-trips create, add rows, get, rename, delete row, and delete", async () => {
    const { app } = await makeDatasetApp();
    const { res, body: dataset } = await create(app);
    expect(res.status).toBe(201);
    expect(dataset.fields).toEqual([{ id: "0", ...stringField("ticket") }]);

    const added = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/rows`,
      json("POST", {
        rows: [
          {
            cells: {
              "0": {
                kind: "resource",
                uri: "pg.ts#seededTask",
                args: { title: text("Milk") },
                // Stripped by the server: a row is a recipe, not a replay.
                receipt: { id: "tsk_abc123" },
              },
            },
            source: {
              kind: "trace",
              traceId: "t1",
              traceProviderId: "local-db",
            },
          },
        ],
      }),
    );
    expect(added.status).toBe(201);

    const list = (await (await app.request("/api/datasets")).json()) as any[];
    expect(list.map(s => [s.id, s.rowCount])).toEqual([[dataset.id, 1]]);

    const got = (await (
      await app.request(`/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}`)
    ).json()) as any;
    expect(got.dataset.name).toBe("Tickets");
    // An overview, not the rows: they're paged in separately.
    expect(got.rowCount).toBe(1);
    expect(got.fields).toEqual({ "0": { keys: ["title"], resource: true } });
    expect(got.rows).toBeUndefined();

    const rows = (await (
      await app.request(
        `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/rows?offset=0&limit=10`,
      )
    ).json()) as any[];
    expect(rows[0].cells["0"]).toEqual({
      kind: "resource",
      uri: "pg.ts#seededTask",
      args: { title: text("Milk") },
    });
    expect(rows[0].source).toEqual({
      kind: "trace",
      traceId: "t1",
      traceProviderId: "local-db",
    });

    const renamed = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}`,
      json("PATCH", { name: "Refunds" }),
    );
    expect(((await renamed.json()) as any).name).toBe("Refunds");

    const rowDeleted = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/rows/${rows[0].id}`,
      { method: "DELETE" },
    );
    expect(rowDeleted.status).toBe(204);

    const deleted = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);
    const gone = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}`,
    );
    expect(gone.status).toBe(404);
  });

  it("pages rows, rejecting a malformed window and an unknown dataset", async () => {
    const { app } = await makeDatasetApp();
    const { body: dataset } = await create(app);
    await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/rows`,
      json("POST", {
        rows: ["a", "b", "c"].map(t => ({ cells: { "0": text(t) } })),
      }),
    );
    const page = (query: string, id = dataset.id) =>
      app.request(`/api/datasets/${DATASET_PROVIDER_ID}/${id}/rows${query}`);

    const middle = (await (await page("?offset=1&limit=1")).json()) as any[];
    expect(middle.map(r => r.cells["0"])).toEqual([text("b")]);
    const all = (await (await page("")).json()) as any[];
    expect(all).toHaveLength(3);

    expect((await page("?offset=-1")).status).toBe(400);
    expect((await page("?limit=abc")).status).toBe(400);
    expect((await page("", "nope")).status).toBe(404);
  });

  it.each([
    ["a non-object cell", "hello"],
    ["an unknown kind", { kind: "mystery" }],
    ["a value with no PropValue", { kind: "value", value: "raw" }],
    ["a dataset reference", { kind: "dataset", uri: "tickets#3" }],
    [
      "a nested dataset reference",
      { kind: "object", properties: { x: { kind: "dataset", uri: "d#1" } } },
    ],
    ["a resource with no uri", { kind: "resource" }],
  ])("rejects %s with a 400", async (_label, cell) => {
    const { app } = await makeDatasetApp();
    const { body: dataset } = await create(app);
    const res = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/rows`,
      json("POST", { rows: [{ cells: { "0": cell } }] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a cell naming a field the dataset doesn't have with a 400", async () => {
    const { app } = await makeDatasetApp();
    const { body: dataset } = await create(app);
    const res = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/rows`,
      json("POST", { rows: [{ cells: { z: text("x") } }] }),
    );
    expect(res.status).toBe(400);
  });

  it("sets and clears cells over PATCH …/rows, broadcasting the change", async () => {
    const { app, events } = await makeDatasetApp();
    const { body: dataset } = await create(app, {
      name: "Tickets",
      fields: [stringField("ticket"), stringField("expected")],
    });
    const rowsUrl = `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/rows`;
    await app.request(
      rowsUrl,
      json("POST", {
        rows: [{ cells: { "0": text("a") } }, { cells: { "0": text("b") } }],
      }),
    );
    const [first, second] = (await (
      await app.request(rowsUrl)
    ).json()) as any[];
    events.length = 0;

    const res = await app.request(
      rowsUrl,
      json("PATCH", {
        updates: [
          { rowId: first.id, cells: { "0": null, "1": text("A") } },
          { rowId: second.id, cells: { "1": text("B") } },
        ],
      }),
    );
    expect(res.status).toBe(204);
    const rows = (await (await app.request(rowsUrl)).json()) as any[];
    expect(rows.map(r => r.cells)).toEqual([
      { "1": text("A") },
      { "0": text("b"), "1": text("B") },
    ]);
    expect(events).toEqual([
      {
        type: "dataset-changed",
        providerId: DATASET_PROVIDER_ID,
        event: { type: "update", datasetId: dataset.id },
      },
    ]);

    // A number in a string field is refused, and nothing changes.
    const bad = await app.request(
      rowsUrl,
      json("PATCH", {
        updates: [
          { rowId: second.id, cells: { "0": text("changed") } },
          {
            rowId: first.id,
            cells: {
              "1": { kind: "value", value: { kind: "primitive", value: 3 } },
            },
          },
        ],
      }),
    );
    expect(bad.status).toBe(400);
    expect(await (await app.request(rowsUrl)).json()).toEqual(rows);
  });

  it("creates a dataset by hand, with no fields and no prompt, and appends an empty row", async () => {
    const { app } = await makeDatasetApp();
    const { res, body: dataset } = await create(app, {
      name: "Scratch",
      fields: [],
    });
    expect(res.status).toBe(201);
    expect(dataset.fields).toEqual([]);
    expect(dataset.prompt).toBeUndefined();

    // What the grid's trailing row sends: no cells, no source.
    const added = await app.request(
      `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/rows`,
      json("POST", { rows: [{ cells: {} }] }),
    );
    expect(added.status).toBe(201);
    const [row] = (await added.json()) as any[];
    expect(row.cells).toEqual({});
    expect(row.source).toBeUndefined();

    const got = (await (
      await app.request(`/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}`)
    ).json()) as any;
    expect(got.rowCount).toBe(1);
  });

  it("rejects fields that aren't unique by name and type", async () => {
    const { app } = await makeDatasetApp();
    const { res } = await create(app, {
      name: "Dupes",
      fields: [stringField("a"), stringField("a")],
    });
    expect(res.status).toBe(400);
  });

  it("resolves the prompt link on read, and drops one that no longer resolves", async () => {
    const { app } = await makeDatasetApp();
    const { body: linked } = await create(app, {
      name: "Linked",
      fields: [],
      prompt: { id: "p#test", providerId: PROVIDER_ID },
    });
    expect(linked.prompt).toEqual({ id: "p#test", providerId: PROVIDER_ID });
    // A global id no prompt claims any more. (A provider-scoped id is
    // trusted as-is, as for spans — the client checks it still exists.)
    await create(app, {
      name: "Orphan",
      fields: [],
      prompt: { id: "retired-global-id" },
    });

    const list = (await (await app.request("/api/datasets")).json()) as any[];
    const byName = Object.fromEntries(list.map(s => [s.name, s]));
    expect(byName.Linked.prompt).toEqual({
      id: "p#test",
      providerId: PROVIDER_ID,
    });
    expect(byName.Orphan.prompt).toBeUndefined();
  });

  it("adds fields by type and by copying a prompt parameter", async () => {
    const title = {
      name: "title",
      type: { kind: "primitive", syntax: "TaskTitle", base: "string" },
      optional: false,
      valueSpan: { start: 1, end: 2 },
    };
    const base = fakeProvider();
    const { app, events } = await makeDatasetApp({
      ...base,
      async getPrompt(ref) {
        const prompt = await base.getPrompt(ref);
        return prompt && { ...prompt, functionParameters: [title as any] };
      },
    });
    const { body: dataset } = await create(app);
    const fieldsUrl = `/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}/fields`;

    const typed = await app.request(
      fieldsUrl,
      json("POST", { name: "expectedTitle", type: "string" }),
    );
    expect(typed.status).toBe(201);
    expect(await typed.json()).toEqual({
      id: "1",
      def: {
        name: "expectedTitle",
        optional: true,
        type: { kind: "primitive", syntax: "string", base: "string" },
      },
      added: true,
    });
    expect(events).toContainEqual({
      type: "dataset-changed",
      providerId: DATASET_PROVIDER_ID,
      event: { type: "update", datasetId: dataset.id },
    });

    // The server looks the parameter up itself, in the prompt provider.
    const copied = await app.request(
      fieldsUrl,
      json("POST", {
        from: { providerId: PROVIDER_ID, promptId: "p#test", path: "title" },
      }),
    );
    expect(copied.status).toBe(201);
    const { valueSpan: _span, ...portable } = title;
    expect(await copied.json()).toEqual({
      id: "2",
      def: portable,
      added: true,
    });

    const missing = await app.request(
      fieldsUrl,
      json("POST", {
        from: { providerId: "nope", promptId: "p#test", path: "title" },
      }),
    );
    expect(missing.status).toBe(400);
    const duplicate = await app.request(
      fieldsUrl,
      json("POST", { name: "expectedTitle", type: "string" }),
    );
    expect(await duplicate.json()).toEqual({
      error: "`expectedTitle: string` already exists",
    });

    const got = (await (
      await app.request(`/api/datasets/${DATASET_PROVIDER_ID}/${dataset.id}`)
    ).json()) as any;
    expect(got.dataset.fields.map((f: any) => f.def.name)).toEqual([
      "ticket",
      "expectedTitle",
      "title",
    ]);
  });

  it("responds 404 for an unknown dataset provider", async () => {
    const { app } = await makeDatasetApp();
    const res = await app.request("/api/datasets/nope/x");
    expect(res.status).toBe(404);
  });

  it("broadcasts dataset changes on the hot-reload stream", async () => {
    const { app, events } = await makeDatasetApp();
    const { body: dataset } = await create(app);
    expect(events).toContainEqual({
      type: "dataset-changed",
      providerId: DATASET_PROVIDER_ID,
      event: { type: "add", datasetId: dataset.id },
    });
  });
});

describe("prompt refs on the prompt routes", () => {
  it("passes ?variation= through to execute and returns what ran", async () => {
    let received: unknown;
    const { app } = makeApp(async ref => {
      received = ref;
      return { version: "abc123", variation: "var_frozen" };
    });
    const res = await app.request(
      new Request(
        "http://localhost/api/prompts/fake/cCN0ZXN0/execute?variation=var_wip",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ functionInputs: [] }),
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(received).toEqual({ promptId: "p#test", variation: "var_wip" });
    expect(await res.json()).toMatchObject({
      version: "abc123",
      variation: "var_frozen",
    });
  });

  it("answers a conflicted variation's run with 409 and the conflicts", async () => {
    const conflicts = [
      { field: "system", base: "a", target: "b", variation: "c" },
    ];
    const { app } = makeApp(async () => {
      throw new VariationConflictError(conflicts);
    });
    const res = await app.request(executeRequest());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ conflicts });
  });

  it("answers an update with the prompt and where it landed", async () => {
    const app = new Hono();
    const provider: PromptProvider = {
      ...fakeProvider(),
      async updatePromptProperties(ref) {
        const prompt = (await provider.getPrompt(ref))!;
        return {
          prompt,
          ref: { promptId: promptIdOf(ref), variation: "var_wip" },
        };
      },
    };
    setupRoutes({
      app,
      promptProviders: new Map([[PROVIDER_ID, provider]]),
      traceProviders: new Map(),
      promptRegistry: new PromptRegistry(),
      hotReloadSubscribers: new Set(),
      rootPath: "/demo",
      hasConfig: true,
      tracer: trace.getTracer("test"),
      defaultTraceProviderId: TRACE_PROVIDER_ID,
    });
    const res = await app.request(
      new Request("http://localhost/api/prompts/fake/cCN0ZXN0/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ style: "chat", system: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      prompt: { id: "p#test", providerId: PROVIDER_ID },
      ref: { promptId: "p#test", variation: "var_wip" },
    });
  });

  it("reports versions and variations as unsupported for a provider without them", async () => {
    const { app } = makeApp();
    const versions = await app.request("/api/prompts/fake/cCN0ZXN0/versions");
    expect(versions.status).toBe(405);
    const save = await app.request("/api/variations/fake/var_x/save", {
      method: "POST",
    });
    expect(save.status).toBe(405);
  });
});
