// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TraceSink } from "./trace-sink.ts";
import type { LLMSpanDetails, Span } from "./trace-types.ts";

/**
 * A model's prices, in $/token. A cache price the catalog doesn't list is
 * left unset, and those tokens are billed at the `input` price instead.
 */
interface PriceEntry {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Normalized model id (see {@link normalizeModelId}) → its price. */
type PriceTable = Map<string, PriceEntry>;

/** A model catalog response, as Vercel AI Gateway and OpenRouter return it. */
interface ModelsResponse {
  data?: { id?: string; pricing?: Record<string, string | undefined> }[];
}

/**
 * A model catalog to fetch prices from, and the `pricing` keys it uses for
 * input and output prices. Both name cache prices `input_cache_read` and
 * `input_cache_write`.
 */
interface Catalog {
  url: string;
  inputKey: string;
  outputKey: string;
}

/** The catalogs to fetch prices from, in order — each only if the last fails. */
const CATALOGS: Catalog[] = [
  {
    url: "https://ai-gateway.vercel.sh/v1/models",
    inputKey: "input",
    outputKey: "output",
  },
  {
    url: "https://openrouter.ai/api/v1/models",
    inputKey: "prompt",
    outputKey: "completion",
  },
];

/**
 * Lowercases a model id and spells version dots as dashes, so a catalog's
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

/** Parses a catalog's $/token string; `undefined` if absent or malformed. */
function parseRate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const rate = parseFloat(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : undefined;
}

/**
 * Indexes a catalog's models by both their full id and their id stripped of
 * its provider prefix, so a span's bare model name (e.g. from a provider SDK
 * that doesn't know about `provider/model` ids) still matches. The first
 * entry for a bare name wins. Models with no input or output price (images,
 * embeddings, free models) are skipped.
 */
function parsePrices(data: ModelsResponse, catalog: Catalog): PriceTable {
  const prices: PriceTable = new Map();
  for (const m of data.data ?? []) {
    if (!m.id || !m.pricing) continue;
    const price: PriceEntry = {
      input: parseRate(m.pricing[catalog.inputKey]) ?? 0,
      output: parseRate(m.pricing[catalog.outputKey]) ?? 0,
      cacheRead: parseRate(m.pricing.input_cache_read),
      cacheWrite: parseRate(m.pricing.input_cache_write),
    };
    if (price.input === 0 && price.output === 0) continue;
    const id = normalizeModelId(m.id);
    const shortId = id.slice(id.lastIndexOf("/") + 1);
    prices.set(id, price);
    if (!prices.has(shortId)) prices.set(shortId, price);
  }
  return prices;
}

/**
 * What a call cost. `promptTokens` counts every input token, cached or not,
 * so the cache reads and writes are carved out of it and billed at their own
 * rates — or at the input rate, if the catalog lists none. Their share of
 * `prompt` is broken out only when the span reports cache usage.
 */
function callCost(
  llm: LLMSpanDetails,
  price: PriceEntry,
): NonNullable<LLMSpanDetails["cost"]> {
  const cacheReadTokens = llm.cacheReadTokens ?? 0;
  const cacheWriteTokens = llm.cacheWriteTokens ?? 0;
  const uncachedTokens = Math.max(
    0,
    (llm.promptTokens ?? 0) - cacheReadTokens - cacheWriteTokens,
  );
  const cacheRead = cacheReadTokens * (price.cacheRead ?? price.input);
  const cacheWrite = cacheWriteTokens * (price.cacheWrite ?? price.input);
  return {
    prompt: uncachedTokens * price.input + cacheRead + cacheWrite,
    completion: (llm.completionTokens ?? 0) * price.output,
    ...(llm.cacheReadTokens !== undefined && { cacheRead }),
    ...(llm.cacheWriteTokens !== undefined && { cacheWrite }),
  };
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
 * Pricing is fetched once, lazily on the first relevant span, from Vercel AI
 * Gateway's public model catalog — or, if that request fails, from
 * OpenRouter's — and cached in memory for the life of the instance. Cache
 * reads and writes are billed at the catalog's cache prices where it lists
 * them. A fetch failure (or an offline environment) is logged to the console
 * but never thrown at the caller; costs just don't get stamped.
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
    const llm = span.llm;
    if (
      !this.fetchPricing ||
      span.kind !== "LLM" ||
      !llm?.model ||
      (llm.promptTokens === undefined && llm.completionTokens === undefined)
    ) {
      return span;
    }

    // Fetch and cache prices if we haven't already.
    this.prices ??= this.fetchPrices();

    const price = findPrice(await this.prices, llm.model);
    if (!price) return span;

    return {
      ...span,
      llm: {
        ...llm,
        cost: callCost(llm, price),
      },
    };
  }

  private async fetchPrices(): Promise<PriceTable> {
    for (const catalog of CATALOGS) {
      const prices = await this.fetchCatalog(catalog);
      if (prices) return prices;
    }
    return new Map();
  }

  /**
   * Fetches and parses one model catalog. Returns `undefined` if the request
   * fails, so the caller can fall back to another — never throws for the
   * caller over this.
   */
  private async fetchCatalog(
    catalog: Catalog,
  ): Promise<PriceTable | undefined> {
    const { url } = catalog;
    try {
      const res = await this.fetchImpl(url);
      if (res.ok) {
        return parsePrices((await res.json()) as ModelsResponse, catalog);
      }
      console.error(
        `Failed to fetch model pricing from ${url}: ${res.status} ${res.statusText}`,
      );
    } catch (err) {
      console.error(`Failed to fetch model pricing from ${url}:`, err);
    }
    return undefined;
  }
}
