// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What the two ad-hoc SQL routes — over traces and over a dataset's rows —
 * share: reading a `{ sql, maxRows? }` body, capping the rows, and relaying
 * the query's failure.
 */

import {
  SqlQueryError,
  type SqlQueryOptions,
  type SqlQueryResult,
} from "../../trace/db/read-only-query.ts";
import { errorResult, type HandlerResult } from "./result.ts";

/** The most rows one SQL query returns, whatever its caller asks for. */
export const MAX_QUERY_ROWS = 10_000;

/** A query body, read: the query to run, or the 400 the body deserves. */
export type ParsedQuery =
  | { ok: true; sql: string; options: SqlQueryOptions }
  | { ok: false; result: HandlerResult };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a query body — `{ sql, maxRows? }`. */
export function parseQueryBody(body: unknown): ParsedQuery {
  if (!isRecord(body) || typeof body.sql !== "string" || !body.sql.trim()) {
    return {
      ok: false,
      result: errorResult(400, "body must be { sql, maxRows? }"),
    };
  }
  const { maxRows } = body;
  if (
    maxRows !== undefined &&
    (typeof maxRows !== "number" || !Number.isInteger(maxRows) || maxRows < 1)
  ) {
    return {
      ok: false,
      result: errorResult(400, "maxRows must be a positive integer"),
    };
  }
  return {
    ok: true,
    sql: body.sql,
    options:
      maxRows === undefined
        ? {}
        : { maxRows: Math.min(maxRows as number, MAX_QUERY_ROWS) },
  };
}

/**
 * Runs the query `body` holds with `run`, answering its rows — or why not:
 * a bad body or bad SQL is a 400, and any other failure goes to
 * `otherFailure` (a 500 by default).
 */
export async function answerQuery(
  body: unknown,
  run: (sql: string, options: SqlQueryOptions) => Promise<SqlQueryResult>,
  otherFailure: (err: unknown) => HandlerResult = err =>
    errorResult(500, err instanceof Error ? err.message : String(err)),
): Promise<HandlerResult> {
  const query = parseQueryBody(body);
  if (!query.ok) return query.result;
  try {
    return { status: 200, body: await run(query.sql, query.options) };
  } catch (err) {
    return err instanceof SqlQueryError
      ? errorResult(400, err.message)
      : otherFailure(err);
  }
}
