// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral handlers for reading, querying, and deleting traces —
 * resolved providers in, {@link HandlerResult} out — shared by the
 * `/api/traces` routes and the MCP server.
 */

import type { Span } from "../../shared/types.ts";
import { SqlQueryError } from "../../trace/db/read-only-query.ts";
import type { TraceProvider } from "../../trace/trace-provider.ts";
import { errorResult, type HandlerResult } from "./result.ts";

/** The most rows one SQL query returns, whatever its caller asks for. */
export const MAX_QUERY_ROWS = 10_000;

const QUERY_UNSUPPORTED = errorResult(
  405,
  "This trace provider does not support SQL queries",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a query body — `{ sql, maxRows? }` — returning the query, or the 400
 * it deserves. Shared with the dataset row query.
 */
export function parseQueryBody(
  body: unknown,
): { sql: string; maxRows?: number } | HandlerResult {
  if (!isRecord(body) || typeof body.sql !== "string" || !body.sql.trim()) {
    return errorResult(400, "body must be { sql, maxRows? }");
  }
  const { maxRows } = body;
  if (
    maxRows !== undefined &&
    (typeof maxRows !== "number" || !Number.isInteger(maxRows) || maxRows < 1)
  ) {
    return errorResult(400, "maxRows must be a positive integer");
  }
  return {
    sql: body.sql,
    ...(maxRows !== undefined && {
      maxRows: Math.min(maxRows as number, MAX_QUERY_ROWS),
    }),
  };
}

/** Relays a query's failure: the caller's SQL is a 400, anything else a 500. */
export function queryFailure(err: unknown): HandlerResult {
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(err instanceof SqlQueryError ? 400 : 500, message);
}

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
  if (!provider.query) return QUERY_UNSUPPORTED;
  const query = parseQueryBody(body);
  if ("status" in query) return query;
  try {
    return {
      status: 200,
      body: await provider.query(query.sql, {
        ...(query.maxRows && { maxRows: query.maxRows }),
      }),
    };
  } catch (err) {
    return queryFailure(err);
  }
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
