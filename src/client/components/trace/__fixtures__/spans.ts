// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Span fixtures covering all three ingestion provenances, so the trace UI's
 * pure layer (`rows.ts`, `usage.ts`) and its components are exercised against
 * every shape a `Span` actually arrives in — see `specs/trace-workshopping.md`
 * §D ("Three-provenance parity"). The shapes differ in ways that have broken
 * rendering before: notably a native-telemetry span carries no `attributes`
 * bag at all, and an OTLP span can carry multi-part (image) message content.
 */

import type { Span } from "../../../../shared/types";

/** A span shaped like the OTel/OTLP ingestion paths produce: attribute bag + derived llm/tool. */
export const otelSpan: Span = {
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
export const nativeSpan: Span = {
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
export const otlpSpan: Span = {
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
export const toolSpan: Span = {
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

/** All four fixtures, for tests that want to sweep every provenance at once. */
export const allProvenanceSpans: Span[] = [
  otelSpan,
  nativeSpan,
  otlpSpan,
  toolSpan,
];

/**
 * A minimal `Span` for tests that only care about tree/timeline structure —
 * `traceId` and `kind` get defaults so a case can name just the ids and times
 * it's actually asserting on.
 */
export function makeSpan(id: string, overrides: Partial<Span> = {}): Span {
  return {
    id,
    traceId: "t1",
    name: id,
    kind: "DEFAULT",
    startTime: 0,
    ...overrides,
  };
}
