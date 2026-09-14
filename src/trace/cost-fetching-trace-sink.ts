// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TraceSink } from "./trace-sink.ts";
import type { Span } from "./trace-types.ts";

/** $/token, as `[input, output]`. */
type PriceEntry = [number, number];

/** Normalized model id (see {@link normalizeModelId}) → its price. */
type PriceTable = Map<string, PriceEntry>;

interface OpenRouterModel {
  id?: string;
  pricing?: { prompt?: string; completion?: string };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

/**
 * Lowercases a model id and spells version dots as dashes, so OpenRouter's
 * `claude-sonnet-4.5` and a provider SDK's `claude-sonnet-4-5` meet.
 */
function normalizeModelId(id: string): string {
  return id.toLowerCase().replaceAll(".", "-");
}

/**
 * Looks up `model`'s price by the longest known id it starts with, cut only at
 * `-` boundaries: `gpt-4o-2024-11-20` resolves to `gpt-4o`, never to `gpt-4`,
 * and `o3` never resolves to a longer id like `o3-pro`.
 */
function findPrice(prices: PriceTable, model: string): PriceEntry | undefined {
  const segments = normalizeModelId(model).split("-");
  for (let n = segments.length; n > 0; n--) {
    const price = prices.get(segments.slice(0, n).join("-"));
    if (price) return price;
  }
  return undefined;
}

/** Options for {@link CostFetchingTraceSink}. */
export interface CostFetchingTraceSinkOptions {
  /**
   * Override for the global `fetch`, so tests can inject a mock instead of
   * hitting the network. Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Whether to fetch pricing (and so stamp costs) at all. When `false`, spans
   * pass through untouched and no request is ever made. Defaults to `true`
   * unless the `EVALUTION_NO_COST_ESTIMATES` environment variable is set.
   */
  fetchPricing?: boolean;
}

/**
 * A {@link TraceSink} that stamps `llm.cost` onto LLM spans with known token
 * usage, then fans the span out to its own registered downstream sinks.
 *
 * Pricing is fetched once, lazily on the first relevant span, from
 * OpenRouter's public model catalog and cached in memory for the life of the
 * instance — a fetch failure (or an offline environment) is logged to the
 * console but never thrown at the caller; costs just don't get stamped.
 */
export class CostFetchingTraceSink implements TraceSink {
  private readonly fetchImpl: typeof fetch;
  private readonly fetchPricing: boolean;
  private readonly sinks: TraceSink[] = [];
  private prices: Promise<PriceTable> | undefined;

  constructor(options: CostFetchingTraceSinkOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.fetchPricing =
      options.fetchPricing ?? !process.env.EVALUTION_NO_COST_ESTIMATES;
  }

  /** Add a downstream sink. May be called multiple times. */
  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  /**
   * Remove a previously-added sink. Returns `true` if the given sink was
   * found and removed, otherwise `false`.
   */
  removeSink(sink: TraceSink): boolean {
    const i = this.sinks.indexOf(sink);
    if (i === -1) return false;
    this.sinks.splice(i, 1);
    return true;
  }

  async recordSpanStart(span: Span): Promise<Span> {
    const stamped = await this.withCost(span);
    await Promise.all(this.sinks.map(s => s.recordSpanStart(stamped)));
    return stamped;
  }

  async recordSpanEnd(span: Span): Promise<Span> {
    const stamped = await this.withCost(span);
    await Promise.all(this.sinks.map(s => s.recordSpanEnd(stamped)));
    return stamped;
  }

  async failTrace(traceId: string, errorMessage: string): Promise<void> {
    await Promise.all(this.sinks.map(s => s.failTrace(traceId, errorMessage)));
  }

  private async withCost(span: Span): Promise<Span> {
    if (
      !this.fetchPricing ||
      span.kind !== "LLM" ||
      !span.llm?.model ||
      (span.llm.promptTokens === undefined &&
        span.llm.completionTokens === undefined)
    ) {
      return span;
    }

    this.prices ??= this.fetchPrices();
    const rates = findPrice(await this.prices, span.llm.model);
    if (!rates) return span;

    const promptCost = (span.llm.promptTokens ?? 0) * rates[0];
    const completionCost = (span.llm.completionTokens ?? 0) * rates[1];
    return {
      ...span,
      llm: {
        ...span.llm,
        cost: { prompt: promptCost, completion: completionCost },
      },
    };
  }

  private async fetchPrices(): Promise<PriceTable> {
    try {
      const res = await this.fetchImpl("https://openrouter.ai/api/v1/models");
      if (res.ok) {
        return this.parsePrices((await res.json()) as OpenRouterModelsResponse);
      }
      console.error(
        `Failed to fetch model pricing: ${res.status} ${res.statusText}`,
      );
    } catch (err) {
      // Costs just won't be stamped — never throw for the caller over this.
      console.error("Failed to fetch model pricing:", err);
    }
    return new Map();
  }

  private parsePrices(data: OpenRouterModelsResponse): PriceTable {
    const prices: PriceTable = new Map();
    for (const m of data.data ?? []) {
      if (!m.id || !m.pricing) continue;
      // OpenRouter prices in $/token
      const inPrice = parseFloat(m.pricing.prompt ?? "0");
      const outPrice = parseFloat(m.pricing.completion ?? "0");
      if (inPrice <= 0 && outPrice <= 0) continue;
      // Index by both the full id and the id stripped of its provider
      // prefix, so a span's bare model name (e.g. from a provider SDK that
      // doesn't know about OpenRouter's `provider/model` ids) still matches.
      // The first entry for a bare name wins.
      const id = normalizeModelId(m.id);
      const shortId = id.slice(id.lastIndexOf("/") + 1);
      prices.set(id, [inPrice, outPrice]);
      if (!prices.has(shortId)) prices.set(shortId, [inPrice, outPrice]);
    }
    return prices;
  }
}
