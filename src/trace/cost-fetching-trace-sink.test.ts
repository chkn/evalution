// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import { CostFetchingTraceSink } from "./cost-fetching-trace-sink.ts";
import { MemoryTraceProvider } from "./memory-trace-provider.ts";
import type { Span } from "./trace-types.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openRouterFetchMock(
  models: { id: string; prompt: string; completion: string }[],
) {
  return vi.fn(async () =>
    jsonResponse({
      data: models.map(m => ({
        id: m.id,
        pricing: { prompt: m.prompt, completion: m.completion },
      })),
    }),
  );
}

function llmSpan(overrides: Partial<Span> = {}): Span {
  return {
    id: "s1",
    traceId: "t1",
    name: "chat",
    kind: "LLM",
    startTime: 0,
    endTime: 100,
    llm: { model: "gpt-4o", promptTokens: 1000, completionTokens: 500 },
    ...overrides,
  };
}

describe("CostFetchingTraceSink", () => {
  it("stamps llm.cost on a relevant span and forwards it to downstream sinks", async () => {
    // $5/1M input, $10/1M output.
    const fetchMock = openRouterFetchMock([
      { id: "openai/gpt-4o", prompt: "0.000005", completion: "0.00001" },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    const provider = new MemoryTraceProvider();
    sink.addSink(provider);

    await sink.recordSpanStart(llmSpan({ llm: { model: "gpt-4o" } }));
    const stored = await sink.recordSpanEnd(llmSpan());

    expect(stored.llm?.cost?.prompt).toBeCloseTo(0.000005 * 1000);
    expect(stored.llm?.cost?.completion).toBeCloseTo(0.00001 * 500);
    const trace = await provider.getTrace("t1");
    expect(trace?.spans[0].llm?.cost).toEqual(stored.llm?.cost);
  });

  it("fetches pricing only once across multiple spans", async () => {
    const fetchMock = openRouterFetchMock([
      { id: "openai/gpt-4o", prompt: "0.000005", completion: "0.00001" },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    sink.addSink(new MemoryTraceProvider());

    await sink.recordSpanEnd(llmSpan({ id: "s1" }));
    await sink.recordSpanEnd(llmSpan({ id: "s2" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves cost unset when the model has no known price", async () => {
    const fetchMock = openRouterFetchMock([
      { id: "openai/gpt-4o", prompt: "0.000005", completion: "0.00001" },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({ llm: { model: "some-unpriced-model", promptTokens: 10 } }),
    );

    expect(stored.llm?.cost).toBeUndefined();
  });

  it("prices a dated model variant by the longest known id it starts with", async () => {
    // `gpt-4` listed first, so a first-substring-match would wrongly pick it.
    const fetchMock = openRouterFetchMock([
      { id: "openai/gpt-4", prompt: "0.00003", completion: "0.00006" },
      { id: "openai/gpt-4o", prompt: "0.000005", completion: "0.00001" },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({
        llm: { model: "gpt-4o-2024-11-20", promptTokens: 1000 },
      }),
    );

    expect(stored.llm?.cost?.prompt).toBeCloseTo(0.000005 * 1000);
  });

  it("does not price a model by a longer id that merely contains it", async () => {
    const fetchMock = openRouterFetchMock([
      { id: "openai/o3-pro", prompt: "0.00002", completion: "0.00008" },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({ llm: { model: "o3", promptTokens: 10 } }),
    );

    expect(stored.llm?.cost).toBeUndefined();
  });

  it("matches a dash-versioned model id against OpenRouter's dotted one", async () => {
    const fetchMock = openRouterFetchMock([
      {
        id: "anthropic/claude-sonnet-4.5",
        prompt: "0.000003",
        completion: "0.000015",
      },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({
        llm: { model: "claude-sonnet-4-5-20250929", completionTokens: 100 },
      }),
    );

    expect(stored.llm?.cost?.completion).toBeCloseTo(0.000015 * 100);
  });

  it("never fetches and passes spans through when EVALUTION_NO_COST_ESTIMATES is set", async () => {
    vi.stubEnv("EVALUTION_NO_COST_ESTIMATES", "1");
    try {
      const fetchMock = openRouterFetchMock([
        { id: "openai/gpt-4o", prompt: "0.000005", completion: "0.00001" },
      ]);
      const sink = new CostFetchingTraceSink({ fetch: fetchMock });
      const provider = new MemoryTraceProvider();
      sink.addSink(provider);

      await sink.recordSpanStart(llmSpan());
      const stored = await sink.recordSpanEnd(llmSpan());

      expect(stored.llm?.cost).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await provider.hasTrace("t1")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("logs and leaves cost unset, without throwing, when the pricing response isn't ok", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const stored = await sink.recordSpanEnd(llmSpan());

      expect(stored.llm?.cost).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].join(" ")).toContain("500");
    } finally {
      spy.mockRestore();
    }
  });

  it("logs and leaves cost unset, without throwing, when fetch itself rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const stored = await sink.recordSpanEnd(llmSpan());

      expect(stored.llm?.cost).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].join(" ")).toContain("network down");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not touch non-LLM spans or LLM spans without usage", async () => {
    const fetchMock = openRouterFetchMock([]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const toolSpan = await sink.recordSpanEnd({
      id: "s1",
      traceId: "t1",
      name: "tool",
      kind: "TOOL",
      startTime: 0,
    });
    const noUsageSpan = await sink.recordSpanEnd(
      llmSpan({ llm: { model: "gpt-4o" } }),
    );

    expect(toolSpan.llm).toBeUndefined();
    expect(noUsageSpan.llm?.cost).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fans a span out to every registered downstream sink", async () => {
    const sink = new CostFetchingTraceSink({
      fetch: openRouterFetchMock([]),
    });
    const a = new MemoryTraceProvider({ id: "a" });
    const b = new MemoryTraceProvider({ id: "b" });
    sink.addSink(a);
    sink.addSink(b);

    await sink.recordSpanStart(llmSpan());
    await sink.recordSpanEnd(llmSpan());

    expect(await a.hasTrace("t1")).toBe(true);
    expect(await b.hasTrace("t1")).toBe(true);
  });

  it("stops forwarding to a sink once it is removed", async () => {
    const sink = new CostFetchingTraceSink({
      fetch: openRouterFetchMock([]),
    });
    const provider = new MemoryTraceProvider();
    sink.addSink(provider);

    expect(sink.removeSink(provider)).toBe(true);
    await sink.recordSpanStart(llmSpan());

    expect(await provider.hasTrace("t1")).toBe(false);
  });

  it("forwards failTrace to every downstream sink", async () => {
    const sink = new CostFetchingTraceSink({
      fetch: openRouterFetchMock([]),
    });
    const provider = new MemoryTraceProvider();
    sink.addSink(provider);

    await sink.recordSpanStart(llmSpan());
    await sink.failTrace("t1", "boom");

    const trace = await provider.getTrace("t1");
    expect(trace?.trace.status).toBe("error");
  });
});
