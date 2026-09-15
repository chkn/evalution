// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { rollupSpans } from "./span-rollup.ts";
import type { Span } from "./trace-types.ts";

function llmSpan(id: string, llm: Span["llm"]): Span {
  return {
    id,
    traceId: "t1",
    name: id,
    kind: "LLM",
    startTime: 0,
    llm,
  };
}

function toolSpan(id: string): Span {
  return { id, traceId: "t1", name: id, kind: "TOOL", startTime: 0 };
}

describe("rollupSpans", () => {
  it("returns everything undefined for spans with no LLM data", () => {
    expect(rollupSpans([toolSpan("a"), toolSpan("b")])).toEqual({
      totalTokens: undefined,
      cost: undefined,
      model: undefined,
    });
  });

  it("sums llm.totalTokens across spans", () => {
    const result = rollupSpans([
      llmSpan("a", { totalTokens: 10 }),
      llmSpan("b", { totalTokens: 5 }),
    ]);
    expect(result.totalTokens).toBe(15);
  });

  it("falls back to promptTokens + completionTokens when totalTokens is missing", () => {
    const result = rollupSpans([
      llmSpan("a", { promptTokens: 3, completionTokens: 4 }),
    ]);
    expect(result.totalTokens).toBe(7);
  });

  it("treats a span reporting only one of prompt/completion tokens as that value", () => {
    const result = rollupSpans([llmSpan("a", { promptTokens: 3 })]);
    expect(result.totalTokens).toBe(3);
  });

  it("mixes totalTokens spans with prompt/completion-only spans", () => {
    const result = rollupSpans([
      llmSpan("a", { totalTokens: 10 }),
      llmSpan("b", { promptTokens: 2, completionTokens: 3 }),
      toolSpan("c"),
    ]);
    expect(result.totalTokens).toBe(15);
  });

  it("sums cost.prompt + cost.completion across spans", () => {
    const result = rollupSpans([
      llmSpan("a", { cost: { prompt: 0.01, completion: 0.02 } }),
      llmSpan("b", { cost: { prompt: 0.001, completion: 0.002 } }),
    ]);
    expect(result.cost).toBeCloseTo(0.033);
  });

  it("returns the model when every span that reports one reports the same one", () => {
    const result = rollupSpans([
      llmSpan("a", { model: "gpt-4o" }),
      llmSpan("b", { model: "gpt-4o" }),
      toolSpan("c"),
    ]);
    expect(result.model).toBe("gpt-4o");
  });

  it("returns undefined for model when spans disagree", () => {
    const result = rollupSpans([
      llmSpan("a", { model: "gpt-4o" }),
      llmSpan("b", { model: "claude-opus-4-5" }),
    ]);
    expect(result.model).toBeUndefined();
  });

  it("returns undefined for model when no span reports one", () => {
    const result = rollupSpans([llmSpan("a", { totalTokens: 5 })]);
    expect(result.model).toBeUndefined();
  });
});
