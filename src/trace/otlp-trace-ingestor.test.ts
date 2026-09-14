// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { MemoryTraceProvider } from "./memory-trace-provider.ts";
import type { NormalizedOtlpSpan } from "./otlp/normalize.ts";
import { OtlpTraceIngestor } from "./otlp-trace-ingestor.ts";

function span(overrides: Partial<NormalizedOtlpSpan>): NormalizedOtlpSpan {
  return {
    traceId: "t1",
    spanId: "s1",
    name: "span",
    startTimeMs: 0,
    statusCode: "unset",
    attributes: {},
    ...overrides,
  };
}

describe("OtlpTraceIngestor", () => {
  it("records a fully-ended root span as a completed trace", async () => {
    const ingestor = new OtlpTraceIngestor();
    const provider = new MemoryTraceProvider();
    ingestor.addSink(provider);

    await ingestor.ingest([
      span({
        name: "chat",
        startTimeMs: 100,
        endTimeMs: 200,
        statusCode: "ok",
      }),
    ]);

    const loaded = await provider.getTrace("t1");
    expect(loaded?.trace.status).toBe("ok");
    expect(loaded?.spans).toHaveLength(1);
    expect(loaded?.spans[0].endTime).toBe(200);
  });

  it("leaves a still-running trace when a span carries no end time", async () => {
    const ingestor = new OtlpTraceIngestor();
    const provider = new MemoryTraceProvider();
    ingestor.addSink(provider);

    await ingestor.ingest([span({ startTimeMs: 5 })]);

    const loaded = await provider.getTrace("t1");
    expect(loaded?.trace.status).toBe("running");
    expect(loaded?.spans[0].endTime).toBeUndefined();
  });

  it("resolves a child delivered before its parent in the same batch", async () => {
    const ingestor = new OtlpTraceIngestor();
    const provider = new MemoryTraceProvider();
    ingestor.addSink(provider);

    // Deliberately out of order: the child appears first in the array.
    await ingestor.ingest([
      span({
        spanId: "child",
        parentSpanId: "root",
        name: "tool",
        startTimeMs: 10,
        endTimeMs: 20,
        statusCode: "ok",
      }),
      span({
        spanId: "root",
        name: "agent",
        startTimeMs: 0,
        endTimeMs: 30,
        statusCode: "ok",
      }),
    ]);

    const loaded = await provider.getTrace("t1");
    expect(loaded?.trace.status).toBe("ok");
    const child = loaded?.spans.find(s => s.id === "child");
    expect(child?.parentId).toBe("root");
  });

  it("maps gen_ai attributes into span kind and LLM details", async () => {
    const ingestor = new OtlpTraceIngestor();
    const provider = new MemoryTraceProvider();
    ingestor.addSink(provider);

    await ingestor.ingest([
      span({
        name: "chat",
        endTimeMs: 10,
        statusCode: "ok",
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4o",
          "gen_ai.usage.input_tokens": 5,
          "gen_ai.usage.output_tokens": 7,
        },
      }),
    ]);

    const loaded = await provider.getTrace("t1");
    const s = loaded?.spans[0];
    expect(s?.kind).toBe("LLM");
    expect(s?.llm?.model).toBe("gpt-4o");
    expect(s?.llm?.totalTokens).toBe(12);
  });

  it("maps tool-call attributes into ToolSpanDetails", async () => {
    const ingestor = new OtlpTraceIngestor();
    const provider = new MemoryTraceProvider();
    ingestor.addSink(provider);

    await ingestor.ingest([
      span({
        name: "search",
        endTimeMs: 10,
        statusCode: "ok",
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "ai.toolCall.name": "search",
          "ai.toolCall.args": JSON.stringify({ query: "cats" }),
          "ai.toolCall.result": JSON.stringify({ count: 3 }),
        },
      }),
    ]);

    const loaded = await provider.getTrace("t1");
    expect(loaded?.spans[0].tool).toEqual({
      toolName: "search",
      input: { query: "cats" },
      output: { count: 3 },
    });
  });

  it("falls back to an exception event's message when status carries none", async () => {
    const ingestor = new OtlpTraceIngestor();
    const provider = new MemoryTraceProvider();
    ingestor.addSink(provider);

    await ingestor.ingest([
      span({
        endTimeMs: 10,
        statusCode: "error",
        events: [
          {
            name: "exception",
            timeMs: 5,
            attributes: { "exception.message": "boom" },
          },
        ],
      }),
    ]);

    const loaded = await provider.getTrace("t1");
    expect(loaded?.spans[0].status).toBe("error");
    expect(loaded?.spans[0].errorMessage).toBe("boom");
  });
});
