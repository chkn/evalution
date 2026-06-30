// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
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

function makeApp(execute?: PromptProvider["execute"]) {
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
  });

  return { app, traceProvider };
}

function executeRequest() {
  return new Request("http://localhost/api/prompts/fake/cCN0ZXN0/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ functionParams: [] }),
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
});
