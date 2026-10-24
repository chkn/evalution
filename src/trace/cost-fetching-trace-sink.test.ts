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

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/models";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

interface MockModel {
  id: string;
  input: string;
  output: string;
  cacheRead?: string;
  cacheWrite?: string;
}

function gatewayCatalog(models: MockModel[]) {
  return {
    object: "list",
    data: models.map(m => ({
      id: m.id,
      object: "model",
      type: "language",
      pricing: {
        input: m.input,
        output: m.output,
        ...(m.cacheRead && { input_cache_read: m.cacheRead }),
        ...(m.cacheWrite && { input_cache_write: m.cacheWrite }),
      },
    })),
  };
}

function openRouterCatalog(models: MockModel[]) {
  return {
    data: models.map(m => ({
      id: m.id,
      pricing: {
        prompt: m.input,
        completion: m.output,
        ...(m.cacheRead && { input_cache_read: m.cacheRead }),
        ...(m.cacheWrite && { input_cache_write: m.cacheWrite }),
      },
    })),
  };
}

/** A fetch that serves `models` from the AI Gateway's catalog. */
function gatewayFetchMock(models: MockModel[]) {
  return vi.fn(async (_url: string | URL | Request) =>
    jsonResponse(gatewayCatalog(models)),
  );
}

/**
 * A fetch whose AI Gateway request fails with `gatewayFailure` (an HTTP status
 * or a thrown error), and whose OpenRouter request serves `models`.
 */
function openRouterFallbackFetchMock(
  gatewayFailure: number | Error,
  models: MockModel[],
) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url) === GATEWAY_URL) {
      if (gatewayFailure instanceof Error) throw gatewayFailure;
      return jsonResponse({ error: "boom" }, gatewayFailure);
    }
    return jsonResponse(openRouterCatalog(models));
  });
}

const GPT_4O: MockModel = {
  id: "openai/gpt-4o",
  input: "0.000005",
  output: "0.00001",
};

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
    const fetchMock = gatewayFetchMock([GPT_4O]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    const provider = new MemoryTraceProvider();
    sink.addSink(provider);

    // A start snapshot hasn't ended (an ended span is final once stored).
    await sink.recordSpanStart(
      llmSpan({ endTime: undefined, llm: { model: "gpt-4o" } }),
    );
    const stored = await sink.recordSpanEnd(llmSpan());

    expect(stored.llm?.cost?.prompt).toBeCloseTo(0.000005 * 1000);
    expect(stored.llm?.cost?.completion).toBeCloseTo(0.00001 * 500);
    const trace = await provider.getTrace("t1");
    expect(trace?.spans[0].llm?.cost).toEqual(stored.llm?.cost);
  });

  it("fetches pricing only once across multiple spans", async () => {
    const fetchMock = gatewayFetchMock([GPT_4O]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    sink.addSink(new MemoryTraceProvider());

    await sink.recordSpanEnd(llmSpan({ id: "s1" }));
    await sink.recordSpanEnd(llmSpan({ id: "s2" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves cost unset when the model has no known price", async () => {
    const fetchMock = gatewayFetchMock([GPT_4O]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({ llm: { model: "some-unpriced-model", promptTokens: 10 } }),
    );

    expect(stored.llm?.cost).toBeUndefined();
  });

  it("prices a dated model variant by the longest known id it starts with", async () => {
    // `gpt-4` listed first, so a first-substring-match would wrongly pick it.
    const fetchMock = gatewayFetchMock([
      { id: "openai/gpt-4", input: "0.00003", output: "0.00006" },
      GPT_4O,
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
    const fetchMock = gatewayFetchMock([
      { id: "openai/o3-pro", input: "0.00002", output: "0.00008" },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({ llm: { model: "o3", promptTokens: 10 } }),
    );

    expect(stored.llm?.cost).toBeUndefined();
  });

  it("matches a dash-versioned model id against the catalog's dotted one", async () => {
    const fetchMock = gatewayFetchMock([
      {
        id: "anthropic/claude-sonnet-4.5",
        input: "0.000003",
        output: "0.000015",
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
      const fetchMock = gatewayFetchMock([GPT_4O]);
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

  it("only fetches the AI Gateway's catalog when it succeeds", async () => {
    const fetchMock = gatewayFetchMock([GPT_4O]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    await sink.recordSpanEnd(llmSpan());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(GATEWAY_URL);
  });

  it("falls back to OpenRouter when the AI Gateway's response isn't ok", async () => {
    const fetchMock = openRouterFallbackFetchMock(503, [GPT_4O]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const stored = await sink.recordSpanEnd(llmSpan());

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        GATEWAY_URL,
        OPENROUTER_URL,
      ]);
      expect(stored.llm?.cost?.prompt).toBeCloseTo(0.000005 * 1000);
      expect(stored.llm?.cost?.completion).toBeCloseTo(0.00001 * 500);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].join(" ")).toContain("503");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to OpenRouter when the AI Gateway request rejects", async () => {
    const fetchMock = openRouterFallbackFetchMock(new Error("network down"), [
      GPT_4O,
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const stored = await sink.recordSpanEnd(llmSpan());

      expect(stored.llm?.cost?.prompt).toBeCloseTo(0.000005 * 1000);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].join(" ")).toContain("network down");
    } finally {
      spy.mockRestore();
    }
  });

  it("logs and leaves cost unset, without throwing, when both catalogs fail", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const stored = await sink.recordSpanEnd(llmSpan());

      expect(stored.llm?.cost).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0].join(" ")).toContain(GATEWAY_URL);
      expect(spy.mock.calls[1].join(" ")).toContain(OPENROUTER_URL);
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
      expect(spy.mock.calls[0].join(" ")).toContain("network down");
    } finally {
      spy.mockRestore();
    }
  });

  it("bills cache reads and writes at the catalog's cache prices", async () => {
    // $3/1M input, $15/1M output, $0.30/1M cache read, $3.75/1M cache write.
    const fetchMock = gatewayFetchMock([
      {
        id: "anthropic/claude-sonnet-4.5",
        input: "0.000003",
        output: "0.000015",
        cacheRead: "0.0000003",
        cacheWrite: "0.00000375",
      },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({
        llm: {
          model: "claude-sonnet-4-5",
          // 1000 input tokens: 600 read from cache, 300 written, 100 neither.
          promptTokens: 1000,
          cacheReadTokens: 600,
          cacheWriteTokens: 300,
          completionTokens: 50,
        },
      }),
    );

    expect(stored.llm?.cost?.prompt).toBeCloseTo(
      100 * 0.000003 + 600 * 0.0000003 + 300 * 0.00000375,
    );
    expect(stored.llm?.cost?.cacheRead).toBeCloseTo(600 * 0.0000003);
    expect(stored.llm?.cost?.cacheWrite).toBeCloseTo(300 * 0.00000375);
    expect(stored.llm?.cost?.completion).toBeCloseTo(50 * 0.000015);
  });

  it("doesn't break out cache costs for a span that reports no cache usage", async () => {
    const sink = new CostFetchingTraceSink({
      fetch: gatewayFetchMock([GPT_4O]),
    });

    const stored = await sink.recordSpanEnd(llmSpan());

    expect(stored.llm?.cost).not.toHaveProperty("cacheRead");
    expect(stored.llm?.cost).not.toHaveProperty("cacheWrite");
  });

  it("bills cache tokens at the input price when the catalog lists no cache price", async () => {
    const fetchMock = gatewayFetchMock([GPT_4O]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({
        llm: {
          model: "gpt-4o",
          promptTokens: 1000,
          cacheReadTokens: 600,
          cacheWriteTokens: 300,
        },
      }),
    );

    expect(stored.llm?.cost?.prompt).toBeCloseTo(1000 * 0.000005);
  });

  it("uses OpenRouter's cache prices when falling back to it", async () => {
    const fetchMock = openRouterFallbackFetchMock(500, [
      { ...GPT_4O, cacheRead: "0.0000025", cacheWrite: "0.00001" },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const stored = await sink.recordSpanEnd(
        llmSpan({
          llm: {
            model: "gpt-4o",
            promptTokens: 1000,
            cacheReadTokens: 600,
            cacheWriteTokens: 300,
          },
        }),
      );

      expect(stored.llm?.cost?.prompt).toBeCloseTo(
        100 * 0.000005 + 600 * 0.0000025 + 300 * 0.00001,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("prices jev-* models from the catalog's input-only `typesafe-ai/jev` entry", async () => {
    // As the AI Gateway lists it: input-priced, with a free output.
    const fetchMock = gatewayFetchMock([
      { id: "typesafe-ai/jev", input: "0.000000042", output: "0" },
    ]);
    const sink = new CostFetchingTraceSink({ fetch: fetchMock });

    const stored = await sink.recordSpanEnd(
      llmSpan({
        llm: { model: "jev-latest", promptTokens: 1000, completionTokens: 500 },
      }),
    );

    expect(stored.llm?.cost?.prompt).toBeCloseTo((0.042 / 1_000_000) * 1000);
    expect(stored.llm?.cost?.completion).toBe(0);
  });

  it("does not touch non-LLM spans or LLM spans without usage", async () => {
    const fetchMock = gatewayFetchMock([]);
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
      fetch: gatewayFetchMock([]),
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
      fetch: gatewayFetchMock([]),
    });
    const provider = new MemoryTraceProvider();
    sink.addSink(provider);

    expect(sink.removeSink(provider)).toBe(true);
    await sink.recordSpanStart(llmSpan());

    expect(await provider.hasTrace("t1")).toBe(false);
  });

  it("forwards failTrace to every downstream sink", async () => {
    const sink = new CostFetchingTraceSink({
      fetch: gatewayFetchMock([]),
    });
    const provider = new MemoryTraceProvider();
    sink.addSink(provider);

    await sink.recordSpanStart(llmSpan());
    await sink.failTrace("t1", "boom");

    const trace = await provider.getTrace("t1");
    expect(trace?.trace.status).toBe("error");
  });
});
