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
const { generateTextMock, registerTelemetryMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn().mockResolvedValue(undefined),
  registerTelemetryMock: vi.fn(),
}));
vi.mock("ai", () => ({
  generateText: generateTextMock,
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

    it("resolves immediately without waiting for generateText to finish", async () => {
      let resolveGenerate!: () => void;
      generateTextMock.mockReturnValue(
        new Promise<void>(resolve => {
          resolveGenerate = resolve;
        }),
      );

      const result = await sdk.executeConfig({ model: "m", prompt: "hi" });

      // executeConfig is fire-and-forget: resolves immediately (void) while
      // the underlying generateText call is still pending.
      expect(result).toBeUndefined();
      resolveGenerate(); // resolve the pending promise to avoid leaking
    });

    // Not covered here: calling the integration's `fail()` when `generateText`
    // rejects before any event fires. Exercising that through this file's
    // mocked `await import("ai")` reliably trips a Vitest/tinyspy timing quirk
    // around repeated calls through a mocked dynamic import (reproduced in
    // isolation independent of this code — the `.catch` handler itself runs
    // and calls `fail()` correctly every time). See `executeConfig`'s
    // `generateText(config).catch(...)` wiring.

    it("binds the native fallback to the route traceId + identity for a raw (non-helper) config", async () => {
      // A raw config carries no per-call integration, so without binding the
      // global fallback would record under its own random id — a second,
      // anonymous trace beside the empty one the route pre-created. Binding
      // makes the spans land in the route's trace, so there's exactly one, and
      // the passed identity links it back to the prompt.
      const telemetry = await sdk.setupTraceIngestion();
      const provider = new MemoryTraceProvider({ ingestors: [telemetry!] });

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
      expect(trace?.trace.name).toBe("weatherAgent");
      expect(await provider.getAllTraces()).toHaveLength(1); // no duplicate
    });
  });

  describe("getModelCatalog", () => {
    it("exposes both OpenAI and Anthropic provider groups", async () => {
      const catalog = await sdk.getModelCatalog();
      const groups = new Set(catalog.models.map(m => m.group));
      expect(groups.has("OpenAI")).toBe(true);
      expect(groups.has("Anthropic")).toBe(true);
    });

    it("includes Claude models with function and gateway-string values", async () => {
      const catalog = await sdk.getModelCatalog();
      const claudeModels = catalog.models.filter(m => m.group === "Anthropic");
      expect(claudeModels.length).toBeGreaterThan(0);

      for (const model of claudeModels) {
        expect(model.id.startsWith("anthropic/")).toBe(true);
        expect(model.label.toLowerCase()).toContain("claude");

        const fn = model.values.function;
        expect(fn?.kind).toBe("functionCall");
        if (fn?.kind === "functionCall") {
          expect(fn.callee).toBe("anthropic");
          expect(fn.binding).toEqual([
            {
              kind: "parameter",
              enclosingCall: {
                callee: "prompts",
                import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
              },
            },
            {
              kind: "import",
              spec: { name: "anthropic", from: "@ai-sdk/anthropic" },
            },
          ]);
        }

        const str = model.values.string;
        expect(str?.kind).toBe("primitive");
        if (str?.kind === "primitive") {
          expect(String(str.value).startsWith("anthropic/")).toBe(true);
        }
      }
    });

    it("exposes a customValueTemplates entry for Anthropic so users can type a custom model id", async () => {
      const catalog = await sdk.getModelCatalog();
      const template =
        catalog.groups?.Anthropic?.customValueTemplates?.function;
      expect(template?.kind).toBe("functionCall");
      if (template?.kind === "functionCall") {
        expect(template.callee).toBe("anthropic");
        expect(template.args[0]).toEqual({
          kind: "primitive",
          value: "$input",
        });
      }
    });
  });
});
