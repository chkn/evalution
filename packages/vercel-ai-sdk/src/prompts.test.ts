// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import type { Tracer } from "@opentelemetry/api";
import type { Telemetry } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPerPromptTelemetry,
  toArray,
} from "../../../src/sdk/vercel-ai-sdk/telemetry.ts";
import { Evalution, type Prompt, prompts } from "./index.js";

describe("prompts() telemetry wrapping — v6 (experimental_telemetry)", () => {
  const psi = { id: "mod" };

  it("forwards args and augments the config with enabled telemetry metadata", () => {
    const build = prompts(psi, () => ({
      greet(name: string) {
        return { model: "m", prompt: `Hi ${name}` };
      },
    }));

    const config: any = build().greet("Ada");

    expect(config.prompt).toBe("Hi Ada");
    expect(config.model).toBe("m");
    expect(config.experimental_telemetry.isEnabled).toBe(true);
    expect(config.experimental_telemetry.metadata).toBeDefined();
  });

  it("stamps the derived global prompt id (`${moduleId}#${name}`) on metadata", () => {
    const build = prompts({ id: "orders" }, () => ({
      summarize() {
        return { model: "m", prompt: "hello" };
      },
    }));

    const config: any = build().summarize();

    expect(config.experimental_telemetry.metadata).toMatchObject({
      "gen_ai.prompt.name": "summarize",
      "evalution.prompt.id": "orders#summarize",
    });
  });

  it("merges prompt attributes into an existing metadata object", () => {
    const build = prompts(psi, () => ({
      classify() {
        return {
          model: "m",
          prompt: "hello",
          experimental_telemetry: {
            isEnabled: false,
            metadata: { "custom.key": "value" },
          } as any,
        };
      },
    }));

    const config: any = build().classify();

    expect(config.experimental_telemetry.metadata).toMatchObject({
      "gen_ai.prompt.name": "classify",
      "evalution.prompt.id": "mod#classify",
      "evalution.span.type": "LLM",
      "custom.key": "value",
    });
  });

  it("preserves an existing experimental_telemetry tracer", () => {
    const fakeTracer = {} as Tracer;
    const build = prompts(psi, () => ({
      classify() {
        return {
          model: "m",
          prompt: "hello",
          experimental_telemetry: { tracer: fakeTracer } as any,
        };
      },
    }));

    const config: any = build().classify();
    expect(config.experimental_telemetry.tracer).toBe(fakeTracer);
  });

  it("leaves non-config return values (e.g. Agent instances) untouched", () => {
    class FakeAgent {
      generate() {
        return "ok";
      }
    }
    const agent = new FakeAgent();
    const build = prompts(psi, () => ({
      agentPrompt() {
        return agent as any;
      },
    }));

    expect(build().agentPrompt()).toBe(agent);
  });
});

describe("prompts() telemetry wrapping — v7 (native Telemetry integrations)", () => {
  const psi = { id: "mod" };

  afterEach(() => {
    delete globalThis.AI_SDK_TELEMETRY_INTEGRATIONS;
  });

  function buildConfig(extra?: Record<string, unknown>): Prompt {
    const build = prompts(psi, () => ({
      greet(name: string) {
        return { model: "m", prompt: `Hi ${name}`, ...extra };
      },
    }));
    return build().greet("Ada");
  }

  it("no OTel: swaps in a per-call Evalution integration", () => {
    const evalution = new Evalution();
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [evalution];

    const config = buildConfig();
    const integrations = toArray(config.telemetry?.integrations);

    expect(integrations).toHaveLength(1);
    expect(integrations[0]).not.toBe(evalution);
    expect(isPerPromptTelemetry(integrations[0])).toBe(true);
  });

  it("matches a cross-bundle Evalution (structural, not instanceof)", () => {
    // In production the globally-registered instance comes from the core
    // `evalution` package's bundle — a different class object than this
    // package's bundled Evalution — so `instanceof` is always false across the
    // boundary. The helper must still find it (by shape) and swap in a per-call
    // integration; otherwise the global fallback records under `ai.generateText`
    // with no prompt identity and the route's pre-created trace stays empty.
    const seen: any[] = [];
    const foreign = {
      // The shared `Symbol.for` brand resolves to the same symbol across
      // bundles, so a foreign-bundle instance is still recognized.
      [Symbol.for("evalution.VercelAISDKTelemetry")]: true,
      nativeTelemetry: "auto",
      createTelemetryForPrompt(identity: any) {
        seen.push(identity);
        // A real cross-bundle instance brands its per-call integration with the
        // shared `Symbol.for` so `isPerPromptTelemetry` recognizes it.
        const integ = { onStart: () => {}, withTraceId: () => ({}) };
        Object.defineProperty(
          integ,
          Symbol.for("evalution.VercelAISDKTelemetry.PerPromptTelemetry"),
          { value: true },
        );
        return integ;
      },
    };
    expect(foreign instanceof Evalution).toBe(false);
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [foreign as any];

    const config = buildConfig();
    const integrations = toArray(config.telemetry?.integrations);

    expect(integrations).toHaveLength(1);
    expect(integrations[0]).not.toBe(foreign);
    expect(isPerPromptTelemetry(integrations[0])).toBe(true);
    expect(seen[0]).toMatchObject({ id: "mod#greet", name: "greet" });
  });

  describe("OpenTelemetry with enrichSpan", () => {
    /** Duck-typed stand-in for `@ai-sdk/otel`'s `OpenTelemetry` integration — the
     * helper matches it by `constructor.name`, so the class name matters. */
    class OpenTelemetry implements Telemetry {
      onStart?: undefined;
      enrichSpan(_opts: unknown) {
        return { "otel.own": true };
      }
    }
    it('OTel present, "auto" (default): defers — drops Evalution, wraps OTel for enrichment, no per-call integration built', () => {
      const evalution = new Evalution();
      const otel = new OpenTelemetry();
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [evalution, otel];

      const config = buildConfig();
      const integrations = toArray(config.telemetry?.integrations);

      expect(integrations).toHaveLength(1);
      expect(integrations.some(isPerPromptTelemetry)).toBe(false);
      expect(integrations[0]).not.toBe(otel); // replaced by the enrichment proxy
      expect(
        integrations[0] instanceof OpenTelemetry
          ? integrations[0].enrichSpan({})
          : {},
      ).toMatchObject({
        "otel.own": true,
        "evalution.prompt.id": "mod#greet",
      });
    });

    it('"always": both the per-call Evalution integration and the enriched OTel proxy are present', () => {
      const evalution = new Evalution({ nativeTelemetry: "always" });
      const otel = new OpenTelemetry();
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [evalution, otel];

      const config = buildConfig();
      const integrations = toArray(config.telemetry?.integrations);

      expect(integrations).toHaveLength(2);
      expect(integrations.some((i: any) => isPerPromptTelemetry(i))).toBe(true);
      expect(
        integrations.some((i: any) => typeof i.enrichSpan === "function"),
      ).toBe(true);
    });
  });

  it("OTel present without enrichSpan: proxy synthesizes enrichSpan that returns prompt attributes", () => {
    // Some OTel integrations (or future SDK versions) may not expose `enrichSpan`.
    // The proxy must still synthesize one so prompt identity reaches OTel spans.
    class OpenTelemetry implements Telemetry {
      onStart?: undefined;
      // no enrichSpan
    }
    const evalution = new Evalution();
    const otel = new OpenTelemetry();
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [evalution, otel];

    const config = buildConfig();
    const integrations = toArray(config.telemetry?.integrations);

    expect(integrations).toHaveLength(1);
    const proxy = integrations[0] as any;
    expect(typeof proxy.enrichSpan).toBe("function");
    expect(proxy.enrichSpan({})).toMatchObject({
      "evalution.prompt.id": "mod#greet",
    });
  });

  it('"never": always defers, even with no OTel integration present', () => {
    const evalution = new Evalution({ nativeTelemetry: "never" });
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [evalution];

    const config = buildConfig();
    const integrations = toArray(config.telemetry?.integrations);

    expect(integrations).toHaveLength(0);
  });

  it("honors an upstream config.telemetry.integrations list over the global one", () => {
    const globalEvalution = new Evalution({ nativeTelemetry: "never" });
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [globalEvalution];

    const localEvalution = new Evalution({ nativeTelemetry: "always" });
    const config = buildConfig({
      telemetry: { integrations: [localEvalution] },
    });
    const integrations = toArray(config.telemetry?.integrations);

    // The local instance's "always" wins — if the global ("never") one had
    // been used instead, no per-call integration would have been built.
    expect(integrations.some(isPerPromptTelemetry)).toBe(true);
  });
});
