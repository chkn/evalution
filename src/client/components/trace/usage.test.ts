// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { nativeSpan, otelSpan, toolSpan } from "./__fixtures__/spans.ts";
import { computeCostBreakdown, summarizeUsage } from "./usage.ts";

describe("summarizeUsage", () => {
  it("sums prompt/completion tokens and cost across spans, and reports a uniform model", () => {
    const spans = [
      otelSpan, // gpt-4o, 3 in / 5 out, no cost
      {
        ...nativeSpan,
        llm: {
          ...nativeSpan.llm,
          model: "gpt-4o",
          cost: { prompt: 0.0004, completion: 0.0006 },
        },
      },
      toolSpan, // no llm details at all
    ];
    expect(summarizeUsage(spans)).toEqual({
      promptTokens: 7,
      completionTokens: 11,
      cost: { prompt: 0.0004, completion: 0.0006 },
      model: "gpt-4o",
    });
  });

  it("leaves model undefined when spans disagree, but still sums tokens/cost", () => {
    const usage = summarizeUsage([otelSpan, nativeSpan]);
    expect(usage.model).toBeUndefined();
    expect(usage.promptTokens).toBe(7);
    expect(usage.completionTokens).toBe(11);
  });

  it("leaves tokens/cost undefined when no span reports them", () => {
    expect(summarizeUsage([toolSpan])).toEqual({
      promptTokens: undefined,
      completionTokens: undefined,
      cost: undefined,
      model: undefined,
    });
  });
});

describe("computeCostBreakdown", () => {
  it("totals prompt + completion and derives the implied $/1M rates", () => {
    const breakdown = computeCostBreakdown({
      promptTokens: 1000,
      completionTokens: 500,
      cost: { prompt: 0.005, completion: 0.005 },
    });
    expect(breakdown).toEqual({
      prompt: 0.005,
      completion: 0.005,
      total: 0.01,
      promptRate: 5,
      completionRate: 10,
    });
  });

  it("omits a rate when its token count is unknown", () => {
    const breakdown = computeCostBreakdown({
      cost: { prompt: 0.005, completion: 0.005 },
    });
    expect(breakdown?.promptRate).toBeUndefined();
    expect(breakdown?.completionRate).toBeUndefined();
    expect(breakdown?.total).toBe(0.01);
  });

  it("returns undefined when no span reported a cost", () => {
    expect(computeCostBreakdown({ promptTokens: 10 })).toBeUndefined();
  });
});
