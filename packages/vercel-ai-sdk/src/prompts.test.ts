// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import type { Tracer } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { prompts } from "./index.js";

describe("prompts() telemetry wrapping", () => {
  const psi = { id: "mod" };

  it("forwards args and augments the config with enabled telemetry metadata", () => {
    const build = prompts(psi, () => ({
      greet(name: string) {
        return { model: "m" as any, prompt: `Hi ${name}` };
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
        return { model: "m" as any, prompt: "hello" };
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
          model: "m" as any,
          prompt: "hello",
          experimental_telemetry: {
            isEnabled: false,
            metadata: { "custom.key": "value" },
          },
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
          model: "m" as any,
          prompt: "hello",
          experimental_telemetry: { tracer: fakeTracer },
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
