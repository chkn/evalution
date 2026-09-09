// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { Span } from "../../../shared/types";
import { toSpanViewModel } from "./spanViewModel.ts";

/** A span shaped like the OTel/OTLP ingestion paths produce: attribute bag + derived llm/tool. */
const otelSpan: Span = {
  id: "s-otel",
  traceId: "t1",
  name: "chat",
  kind: "LLM",
  startTime: 1000,
  endTime: 1500,
  status: "ok",
  attributes: {
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "gpt-4o",
  },
  llm: {
    provider: "openai",
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    output: "hello",
    promptTokens: 3,
    completionTokens: 5,
    totalTokens: 8,
  },
};

/**
 * A span shaped like native Vercel AI SDK v7 telemetry: no OTel attribute bag
 * at all (`attributes: undefined`) — the case Workshop components that
 * assume `input_payload`-style strings would render empty for.
 */
const nativeSpan: Span = {
  id: "s-native",
  traceId: "t1",
  parentId: "t1:root",
  name: "step: 0",
  kind: "LLM",
  startTime: 1000,
  endTime: 1200,
  status: "ok",
  llm: {
    provider: "anthropic",
    model: "claude-opus-5",
    messages: [{ role: "user", content: "hi" }],
    output: "hello",
    promptTokens: 4,
    completionTokens: 6,
    totalTokens: 10,
  },
};

/** A span shaped like the OTLP ingestion path, carrying multi-part (image) content. */
const otlpSpan: Span = {
  id: "s-otlp",
  traceId: "t1",
  name: "chat",
  kind: "LLM",
  startTime: 2000,
  endTime: 2100,
  status: "ok",
  attributes: { "gen_ai.request.model": "gemini-3" },
  llm: {
    provider: "google",
    model: "gemini-3",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", image: "https://x/y.png", mediaType: "image/png" },
        ],
      },
    ],
  },
};

/** A tool-kind span, as either OTel/OTLP or native telemetry might produce. */
const toolSpan: Span = {
  id: "s-tool",
  traceId: "t1",
  parentId: "t1:root",
  name: "tool: search",
  kind: "TOOL",
  startTime: 1200,
  endTime: 1300,
  status: "ok",
  tool: { toolName: "search", input: { query: "cats" }, output: { count: 3 } },
};

describe("toSpanViewModel", () => {
  it("maps an OTel-provenance span, keeping raw attributes alongside derived llm fields", () => {
    const vm = toSpanViewModel(otelSpan);
    expect(vm).toMatchObject({
      id: "s-otel",
      spanType: "LLM",
      startMs: 1000,
      endMs: 1500,
      durationMs: 500,
      status: "ok",
      attributes: { "gen_ai.request.model": "gpt-4o" },
      provider: "openai",
      model: "gpt-4o",
      output: "hello",
      totalTokens: 8,
    });
    expect(vm.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps a native-telemetry span with no attributes at all", () => {
    const vm = toSpanViewModel(nativeSpan);
    expect(vm.attributes).toBeUndefined();
    expect(vm).toMatchObject({
      id: "s-native",
      parentId: "t1:root",
      spanType: "LLM",
      provider: "anthropic",
      model: "claude-opus-5",
      totalTokens: 10,
    });
  });

  it("maps an OTLP-provenance span carrying multi-part (image) message content", () => {
    const vm = toSpanViewModel(otlpSpan);
    expect(vm.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", image: "https://x/y.png", mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("maps a TOOL span's toolName/toolArgs/toolResult, with no llm fields", () => {
    const vm = toSpanViewModel(toolSpan);
    expect(vm.toolName).toBe("search");
    expect(vm.toolArgs).toEqual({ query: "cats" });
    expect(vm.toolResult).toEqual({ count: 3 });
    expect(vm.provider).toBeUndefined();
    expect(vm.messages).toBeUndefined();
  });

  it("leaves durationMs/endMs undefined for a still-running span", () => {
    const vm = toSpanViewModel({
      ...otelSpan,
      endTime: undefined,
      status: undefined,
    });
    expect(vm.endMs).toBeUndefined();
    expect(vm.durationMs).toBeUndefined();
  });

  it("maps the prompt reference when present", () => {
    const vm = toSpanViewModel({
      ...otelSpan,
      prompt: { id: "mod#greet", providerId: "fs" },
    });
    expect(vm.promptId).toBe("mod#greet");
    expect(vm.promptProviderId).toBe("fs");
  });
});
