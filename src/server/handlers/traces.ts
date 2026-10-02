// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral handlers for reading, querying, and deleting traces —
 * resolved providers in, {@link HandlerResult} out — shared by the
 * `/api/traces` routes and the MCP server.
 */

import type { Span } from "../../shared/types.ts";
import type { TraceProvider } from "../../trace/trace-provider.ts";
import { answerQuery } from "./query.ts";
import { errorResult, type HandlerResult } from "./result.ts";

const QUERY_UNSUPPORTED = errorResult(
  405,
  "This trace provider does not support SQL queries",
);

/** `GET /api/traces` — summaries of every trace across `providers`, per provider newest first. */
export async function handleListTraces(
  providers: Iterable<TraceProvider>,
): Promise<HandlerResult> {
  try {
    const results = await Promise.all(
      Array.from(providers, p => p.getAllTraces()),
    );
    return { status: 200, body: results.flat() };
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/** `GET /api/traces/:providerId/:id` — a trace together with its spans. */
export async function handleGetTrace(
  provider: TraceProvider,
  traceId: string,
  resolveSpanPrompt: (span: Span) => Span,
): Promise<HandlerResult> {
  try {
    const trace = await provider.getTrace(traceId);
    if (!trace) return errorResult(404, "Trace not found");
    return {
      status: 200,
      body: { ...trace, spans: trace.spans.map(resolveSpanPrompt) },
    };
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/** `DELETE /api/traces/:providerId/:id` — a trace with its spans and annotations. */
export async function handleDeleteTrace(
  provider: TraceProvider,
  traceId: string,
): Promise<HandlerResult> {
  if (!provider.deleteTrace) {
    return errorResult(
      405,
      "This trace provider does not support deleting traces",
    );
  }
  try {
    const deleted = await provider.deleteTrace(traceId);
    return deleted
      ? { status: 204, body: undefined }
      : errorResult(404, "Trace not found");
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/**
 * `POST /api/trace-providers/:providerId/query` — body `{ sql, maxRows? }`:
 * one read-only SQL query against the provider's store, written against
 * {@link handleGetTraceQuerySchema}'s tables.
 */
export async function handleQueryTraces(
  provider: TraceProvider,
  body: unknown,
): Promise<HandlerResult> {
  const { query } = provider;
  if (!query) return QUERY_UNSUPPORTED;
  return answerQuery(body, (sql, options) =>
    query.call(provider, sql, options),
  );
}

/**
 * `GET /api/trace-providers/:providerId/schema` — `{ schema }`, the
 * annotated SQL DDL of the tables {@link handleQueryTraces} queries.
 */
export function handleGetTraceQuerySchema(
  provider: TraceProvider,
): HandlerResult {
  if (!provider.getQuerySchema) return QUERY_UNSUPPORTED;
  return { status: 200, body: { schema: provider.getQuerySchema() } };
}
