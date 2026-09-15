// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { MemoryTraceProvider } from "./memory-trace-provider.ts";
import { runTraceProviderContractTests } from "./trace-provider-contract.ts";

runTraceProviderContractTests(
  "MemoryTraceProvider",
  async opts => new MemoryTraceProvider(opts),
);

describe("MemoryTraceProvider getAllTraces rollups", () => {
  it("rolls up tokens/cost/model from spans, and always reports zero annotation counts", async () => {
    const provider = new MemoryTraceProvider();
    await provider.recordSpanStart({
      id: "a:root",
      traceId: "a",
      name: "root",
      kind: "LLM",
      startTime: 1,
    });
    await provider.recordSpanEnd({
      id: "a:root",
      traceId: "a",
      name: "root",
      kind: "LLM",
      startTime: 1,
      endTime: 2,
      status: "ok",
      llm: {
        model: "gpt-4o",
        totalTokens: 12,
        cost: { prompt: 0.004, completion: 0.006 },
      },
    });

    const [summary] = await provider.getAllTraces();
    expect(summary).toMatchObject({
      totalTokens: 12,
      cost: 0.01,
      model: "gpt-4o",
      annotationCounts: { issue: 0, good: 0, note: 0 },
    });
  });
});
