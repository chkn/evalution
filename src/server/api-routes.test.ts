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
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import type { ExecuteRequest } from "../shared/types.ts";
import { runMigrations } from "../trace/db/migrate.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
import { OtlpTraceIngestor } from "../trace/otlp-trace-ingestor.ts";
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
          modelEditable: true,
          systemEditable: true,
          messages: [],
          messagesEditable: true,
          modelParameters: [],
        },
      ];
    },
    async getPrompt(id: string) {
      return id === "p#test"
        ? {
            id,
            name: "test",
            functionParameters: [],
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
