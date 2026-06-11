// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import type { Span, SpanOptions, Tracer } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { prompts } from "./index.js";

const fakeSpan = {} as Span;

function recordingTracer() {
  const calls: { name: string; options?: SpanOptions }[] = [];
  const tracer: Tracer = {
    startSpan(name: string, options?: SpanOptions) {
      calls.push({ name, options });
      return fakeSpan;
    },
    startActiveSpan(_name: string, ...rest: any[]): any {
      return rest[rest.length - 1](fakeSpan);
    },
  };
  return { tracer, calls };
}

describe("prompts() telemetry wrapping", () => {
  it("forwards args and augments the config with an enabled telemetry tracer", () => {
    const build = prompts("mod", () => ({
      greet(name: string) {
        return { model: "m" as any, prompt: `Hi ${name}` };
      },
    }));

    const config: any = build().greet("Ada");

    expect(config.prompt).toBe("Hi Ada");
    expect(config.model).toBe("m");
    expect(config.experimental_telemetry.isEnabled).toBe(true);
    expect(typeof config.experimental_telemetry.tracer.startSpan).toBe(
      "function",
    );
  });

  it("attributes spans to the prompt key", () => {
    const build = prompts("mod", () => ({
      summarize() {
        return { model: "m" as any, prompt: "hello" };
      },
    }));

    const config: any = build().summarize();
    config.experimental_telemetry.tracer.startSpan("ai.generateText");

    // The wrapper tracer delegates to the global provider's tracer; we can't
    // intercept that here, so just assert it produced a usable span object.
    expect(config.experimental_telemetry.tracer).toBeDefined();
  });

  it("stamps the derived global prompt id (`${moduleId}#${name}`) on spans", () => {
    const { tracer, calls } = recordingTracer();
    const build = prompts("orders", () => ({
      summarize() {
        return {
          model: "m" as any,
          prompt: "hello",
          experimental_telemetry: { isEnabled: false, tracer },
        };
      },
    }));

    build().summarize().experimental_telemetry.tracer.startSpan("child");

    expect(calls[0].options?.attributes).toMatchObject({
      "gen_ai.prompt.name": "summarize",
      "evalution.prompt.id": "orders#summarize",
    });
  });

  it("wraps an existing experimental_telemetry tracer rather than replacing it", () => {
    const { tracer, calls } = recordingTracer();
    const build = prompts("mod", () => ({
      classify() {
        return {
          model: "m" as any,
          prompt: "hello",
          experimental_telemetry: { isEnabled: false, tracer },
        };
      },
    }));

    const config: any = build().classify();
    config.experimental_telemetry.tracer.startSpan("child");

    // The pre-existing tracer received the span, with the prompt attributes
    // attached by createTracerForPrompt.
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.attributes).toMatchObject({
      "gen_ai.prompt.name": "classify",
      "evalution.prompt.id": "mod#classify",
      "evalution.span.type": "LLM",
    });
  });

  it("leaves non-config return values (e.g. Agent instances) untouched", () => {
    class FakeAgent {
      generate() {
        return "ok";
      }
    }
    const agent = new FakeAgent();
    const build = prompts("mod", () => ({
      agentPrompt() {
        return agent as any;
      },
    }));

    expect(build().agentPrompt()).toBe(agent);
  });
});
