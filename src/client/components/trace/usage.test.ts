// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { CHECK_ATTRIBUTE } from "../../../trace/trace-types.ts";
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

  it("sums cache tokens and cache costs across the spans that report them", () => {
    const span = (cacheRead: number, cost: number) => ({
      ...nativeSpan,
      llm: {
        ...nativeSpan.llm,
        cacheReadTokens: cacheRead,
        cost: { prompt: cost, completion: 0, cacheRead: cost },
      },
    });
    const usage = summarizeUsage([span(10, 0.001), span(20, 0.002), otelSpan]);
    expect(usage.cacheReadTokens).toBe(30);
    expect(usage.cacheWriteTokens).toBeUndefined();
    expect(usage.cost?.cacheRead).toBeCloseTo(0.003);
    expect(usage.cost).not.toHaveProperty("cacheWrite");
  });

  it("leaves model undefined when spans disagree, but still sums tokens/cost", () => {
    const usage = summarizeUsage([otelSpan, nativeSpan]);
    expect(usage.model).toBeUndefined();
    expect(usage.promptTokens).toBe(7);
    expect(usage.completionTokens).toBe(11);
  });

  it("leaves out what an eval check recorded while judging the trace", () => {
    const judge = {
      ...nativeSpan,
      attributes: { [CHECK_ATTRIBUTE]: "c1" },
      llm: { ...nativeSpan.llm, cost: { prompt: 1, completion: 1 } },
    };
    expect(summarizeUsage([otelSpan, judge])).toEqual(
      summarizeUsage([otelSpan]),
    );
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

  it("breaks cache reads and writes out of the prompt cost, each with its implied rate", () => {
    // 1000 prompt tokens: 600 read from cache, 300 written, 100 neither.
    const breakdown = computeCostBreakdown({
      promptTokens: 1000,
      cacheReadTokens: 600,
      cacheWriteTokens: 300,
      completionTokens: 100,
      cost: {
        prompt: 0.0003 + 0.00018 + 0.001125,
        completion: 0.0015,
        cacheRead: 0.00018,
        cacheWrite: 0.001125,
      },
    });
    expect(breakdown?.prompt).toBeCloseTo(0.0003);
    expect(breakdown?.promptRate).toBeCloseTo(3);
    expect(breakdown?.cacheRead).toBeCloseTo(0.00018);
    expect(breakdown?.cacheReadRate).toBeCloseTo(0.3);
    expect(breakdown?.cacheWrite).toBeCloseTo(0.001125);
    expect(breakdown?.cacheWriteRate).toBeCloseTo(3.75);
    expect(breakdown?.total).toBeCloseTo(0.0003 + 0.00018 + 0.001125 + 0.0015);
  });

  it("omits a cache row when the trace touched no cached tokens", () => {
    const breakdown = computeCostBreakdown({
      promptTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: { prompt: 0.005, completion: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(breakdown).not.toHaveProperty("cacheRead");
    expect(breakdown).not.toHaveProperty("cacheWrite");
    expect(breakdown?.prompt).toBe(0.005);
    expect(breakdown?.promptRate).toBe(5);
  });

  it("returns undefined when no span reported a cost", () => {
    expect(computeCostBreakdown({ promptTokens: 10 })).toBeUndefined();
  });
});
