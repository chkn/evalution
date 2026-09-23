// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTraceProvider } from "../../trace/memory-trace-provider.ts";
import { VercelAISDK } from "./index.ts";
import { isPerPromptTelemetry, toArray } from "./telemetry.ts";

// `ai` is an optional peer dependency that the adapter imports lazily inside
// `executeConfig`. Mock it so the test exercises that dynamic-import path
// without depending on the real package being resolvable. `registerTelemetry`
// makes the adapter take its v7 native path in `setupTraceIngestion`.
const { generateTextMock, evaluateMock, registerTelemetryMock } = vi.hoisted(
  () => ({
    generateTextMock: vi.fn().mockResolvedValue(undefined),
    evaluateMock: vi.fn().mockResolvedValue(undefined),
    registerTelemetryMock: vi.fn(),
  }),
);
vi.mock("ai", () => ({
  generateText: generateTextMock,
  experimental_evaluate: evaluateMock,
  registerTelemetry: registerTelemetryMock,
}));

describe("VercelAISDK", () => {
  const sdk = new VercelAISDK();

  describe("executeConfig", () => {
    beforeEach(() => generateTextMock.mockReset().mockResolvedValue(undefined));

    it("lazily imports `ai` and delegates to generateText with the config", async () => {
      const config = { model: "anthropic/claude-opus-4-8", prompt: "hi" };
      await sdk.executeConfig(config);
      expect(generateTextMock).toHaveBeenCalledTimes(1);
      expect(generateTextMock).toHaveBeenCalledWith(config);
    });

    it("merges resolved execute values into the call it already owns", async () => {
      // `toolsContext` is a top-level `generateText` argument, so the merge is
      // this adapter's business — a generic spread would have to assume every
      // execute parameter's name is a config key.
      const toolsContext = { list_tasks: { db: {} } };
      await sdk.executeConfig(
        { model: "m", prompt: "hi" },
        { executeValues: { toolsContext } },
      );
      expect(generateTextMock).toHaveBeenCalledWith({
        model: "m",
        prompt: "hi",
        toolsContext,
      });
    });

    it("returns a handle that settles only once the run is over", async () => {
      let resolveGenerate!: () => void;
      generateTextMock.mockReturnValue(
        new Promise<void>(resolve => {
          resolveGenerate = resolve;
        }),
      );

      const handle = await sdk.executeConfig({ model: "m", prompt: "hi" });

      // executeConfig stays fire-and-forget — it resolves while generateText
      // is still pending — but now hands back the completion signal that
      // run-scoped resource teardown hangs off.
      let settled = false;
      void handle!.done.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveGenerate();
      await handle!.done;
      expect(settled).toBe(true);
    });

    // Not covered here: anything on the path where `generateText` *rejects* —
    // the integration's `fail()`, and `done` settling rather than rejecting.
    // Exercising either through this file's mocked `await import("ai")`
    // reliably trips a Vitest/tinyspy timing quirk around repeated calls
    // through a mocked dynamic import, which re-invokes the mock during
    // teardown with no handler attached and reports the rejection as
    // unhandled. (Reproduced in isolation independent of this code — the
    // rejection handler itself runs correctly every time.) See
    // `executeConfig`'s `generateText(config).then(ok, fail)` wiring.

    it("binds the native fallback to the route traceId + identity for a raw (non-helper) config", async () => {
      // A raw config carries no per-call integration, so without binding the
      // global fallback would record under its own random id — a second,
      // anonymous trace beside the empty one the route pre-created. Binding
      // makes the spans land in the route's trace, so there's exactly one, and
      // the passed identity links it back to the prompt.
      const telemetry = await sdk.setupTraceIngestion();
      const provider = new MemoryTraceProvider();
      telemetry!.addSink(provider);

      let work: Promise<void> | undefined;
      generateTextMock.mockImplementation((cfg: any) => {
        const integ: any = toArray(cfg?.telemetry?.integrations).find(
          isPerPromptTelemetry,
        );
        // Guard: a spurious re-invocation during teardown (a known mocked
        // dynamic-import timing quirk) passes a config with no integration.
        if (integ) {
          work = (async () => {
            await integ.onStart({
              callId: "c1",
              operationId: "ai.generateText",
              provider: "openai",
              modelId: "gpt",
              messages: [],
            });
            await integ.onEnd({ callId: "c1" });
          })();
        }
        return Promise.resolve(undefined);
      });

      await sdk.executeConfig(
        { model: "m", prompt: "hi" },
        {
          traceId: "route-trace",
          identity: {
            id: "weather.ts#weatherAgent",
            name: "weatherAgent",
            functionParameters: [],
          },
        },
      );
      await work;

      const trace = await provider.getTrace("route-trace");
      expect(trace?.spans.length).toBeGreaterThan(0);
      const root = trace?.spans.find(s => !s.parentId);
      expect(root?.prompt?.id).toBe("weather.ts#weatherAgent");
      expect(trace?.trace.name).toBe("weather.ts#weatherAgent");
      expect(await provider.getAllTraces()).toHaveLength(1); // no duplicate
    });
  });

  describe("executeConfig for an evaluation", () => {
    const config = {
      model: "jev-latest",
      state: "I was charged twice.",
      questions: {
        refund: { type: "boolean", instructions: "Asking for money back?" },
      },
    };
    const identity = { id: "triage#route", name: "route" };

    beforeEach(() => {
      generateTextMock.mockReset().mockResolvedValue(undefined);
      evaluateMock.mockReset().mockResolvedValue(undefined);
    });

    it("calls experimental_evaluate for a config that asks questions", async () => {
      await (await sdk.executeConfig(config))!.done;
      expect(evaluateMock).toHaveBeenCalledWith(config);
      expect(generateTextMock).not.toHaveBeenCalled();
    });

    it("traces it through the same trace-bound integration as a generation", async () => {
      const telemetry = await sdk.setupTraceIngestion();
      const provider = new MemoryTraceProvider();
      telemetry!.addSink(provider);

      evaluateMock.mockImplementation(async (cfg: any) => {
        const integ: any = toArray(cfg?.telemetry?.integrations).find(
          isPerPromptTelemetry,
        );
        if (!integ) return;
        const start = {
          callId: "e1",
          operationId: "ai.evaluate",
          provider: "typesafe.evaluation",
          modelId: "jev-latest",
          state: cfg.state,
          questions: cfg.questions,
        };
        await integ.experimental_onEvaluateStart(start);
        await integ.experimental_onEvaluateEnd({
          ...start,
          answers: { refund: { type: "boolean", probability: 0.9 } },
          usage: {},
        });
      });

      const handle = await sdk.executeConfig(config, {
        traceId: "eval-trace",
        identity,
      });
      await handle!.done;

      const trace = await provider.getTrace("eval-trace");
      expect(trace?.trace.status).toBe("ok");
      expect(trace?.trace.name).toBe("triage#route");
      expect(trace?.spans[0].llm?.output).toEqual({
        refund: { type: "boolean", probability: 0.9 },
      });
    });

    it("fails the trace with an upgrade hint when `ai` doesn't report evaluations", async () => {
      const telemetry = await sdk.setupTraceIngestion();
      const provider = new MemoryTraceProvider();
      telemetry!.addSink(provider);
      // The route pre-creates the trace the run is recorded into.
      await provider.recordSpanStart({
        id: "old-ai:root",
        traceId: "old-ai",
        name: "route",
        kind: "LLM",
        startTime: Date.now(),
      });

      // An `ai` before 7.0.111: evaluates, but sends no telemetry events.
      const handle = await sdk.executeConfig(config, {
        traceId: "old-ai",
        identity,
      });
      await handle!.done;

      const trace = await provider.getTrace("old-ai");
      expect(trace?.trace.status).toBe("error");
      expect((trace?.trace as any).attributes?.errorMessage).toMatch(
        /7\.0\.111/,
      );
    });
  });
});
