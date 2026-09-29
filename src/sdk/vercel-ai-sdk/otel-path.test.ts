// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { trace } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { MemoryTraceProvider } from "../../trace/memory-trace-provider.ts";
import { VercelAISDK } from "./index.ts";

// `ai` ≤ v6: no `registerTelemetry`, so the adapter takes the OTel path. Its
// `generateText` stands in for the SDK's own: when telemetry is enabled it
// opens a span under whatever is active, carrying the config's
// `experimental_telemetry.metadata` under `ai.telemetry.metadata.*`, as v6
// does.
const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(async (config: any) => {
    const telemetry = config.experimental_telemetry;
    if (!telemetry?.isEnabled) return;
    const { trace } = await import("@opentelemetry/api");
    const attributes = Object.fromEntries(
      Object.entries(telemetry.metadata ?? {}).map(([k, v]) => [
        `ai.telemetry.metadata.${k}`,
        v as string,
      ]),
    );
    trace
      .getTracer("ai")
      .startActiveSpan("ai.generateText", { attributes }, span => span.end());
  }),
}));
vi.mock("ai", () => ({
  generateText: generateTextMock,
  registerTelemetry: undefined,
  experimental_evaluate: undefined,
}));

const identity = {
  id: "support.prompt.ts#triage",
  name: "triage",
  functionInputs: [
    { kind: "value", value: { kind: "primitive", value: "hi" } },
  ],
  version: "abc123",
  variation: "var_frozen",
};

/** Runs `config` the way the execute route does: under a span of its own. */
async function runAsRoute(sdk: VercelAISDK, config: object) {
  const store = new MemoryTraceProvider();
  (await sdk.setupTraceIngestion())!.addSink(store);
  let traceId = "";
  await trace.getTracer("evalution").startActiveSpan("triage", async span => {
    traceId = span.spanContext().traceId;
    const handle = await sdk.executeConfig(config, { traceId, identity });
    await handle?.done;
    span.end();
  });
  await vi.waitFor(async () => {
    expect((await store.getTrace(traceId))?.spans).toHaveLength(2);
  });
  return (await store.getTrace(traceId))!.spans;
}

describe("VercelAISDK on the OTel path", () => {
  it("records the run's identity on the root span, and turns spans on for a raw config", async () => {
    const spans = await runAsRoute(new VercelAISDK(), {
      model: "m",
      prompt: "hi",
    });
    const root = spans.find(s => s.name === "triage")!;
    expect(root.kind).toBe("AGENT");
    expect(root.prompt).toMatchObject({
      id: identity.id,
      functionInputs: identity.functionInputs,
      version: "abc123",
      variation: "var_frozen",
    });
    expect(spans.find(s => s.name === "ai.generateText")).toBeDefined();
  });

  it("links spans the prompts() helper tagged through telemetry metadata", async () => {
    const spans = await runAsRoute(new VercelAISDK(), {
      model: "m",
      prompt: "hi",
      experimental_telemetry: {
        isEnabled: true,
        metadata: {
          "evalution.prompt.id": "support#triage",
          "evalution.span.type": "LLM",
        },
      },
    });
    const child = spans.find(s => s.name === "ai.generateText")!;
    expect(child.kind).toBe("LLM");
    expect(child.prompt?.id).toBe("support#triage");
  });
});
