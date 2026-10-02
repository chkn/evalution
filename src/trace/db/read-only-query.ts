// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runs caller-written SQL against a Turso client without letting it write.
 * Shared by the trace and dataset stores, which both answer ad-hoc queries
 * (`TraceProvider.query`, `DatasetProvider.queryRows`) for the REST API and
 * the MCP server. fs-free, like everything else in this directory.
 */

import type { Database } from "@tursodatabase/sync";

/** The rows an ad-hoc SQL query returned. */
export interface SqlQueryResult {
  /** Column names, in the order the query selected them. */
  columns: string[];
  /** One object per row, keyed by column name. */
  rows: Record<string, unknown>[];
  /** True when more rows matched than {@link SqlQueryOptions.maxRows}. */
  truncated?: boolean;
}

/** Options for an ad-hoc SQL query. */
export interface SqlQueryOptions {
  /** The most rows to return. Defaults to {@link DEFAULT_MAX_QUERY_ROWS}. */
  maxRows?: number;
  /**
   * How long the query may run, in milliseconds, where it runs off the main
   * thread (see `./query-worker.ts`). Defaults to
   * {@link DEFAULT_QUERY_TIMEOUT_MS}. A
   * query on a store's own connection can't be stopped, and ignores this.
   */
  timeoutMs?: number;
}

/**
 * Runs one ad-hoc, read-only query — how a Turso store answers one when it
 * isn't to run on the store's own connection (see `./query-worker.ts`).
 */
export type ReadOnlyQueryRunner = (
  query: string,
  options?: SqlQueryOptions,
) => Promise<SqlQueryResult>;

/** How long a query may run off the main thread when its caller doesn't say. */
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/** How many rows a query returns when its caller doesn't say. */
export const DEFAULT_MAX_QUERY_ROWS = 1000;

/** Thrown when a query is refused or fails: the caller's SQL is at fault. */
export class SqlQueryError extends Error {
  override name = "SqlQueryError";
}

/**
 * Runs one `SELECT` (or other row-returning, read-only statement) on
 * `client`, returning at most `maxRows` rows.
 *
 * Writes are refused twice over: by SQLite itself, with `PRAGMA query_only`
 * on for the duration of the query, and up front, by refusing any statement
 * that returns no rows (which covers a `PRAGMA query_only = 0` smuggled in as
 * the statement itself). Only the first statement of a multi-statement string
 * is ever prepared, so nothing after it runs.
 *
 * The caller must keep its own writes off `client` while this runs — the
 * pragma is per-connection — which both Turso stores do by queueing it on
 * their serialized-write chain.
 */
export async function runReadOnlyQuery(
  client: Database,
  query: string,
  { maxRows = DEFAULT_MAX_QUERY_ROWS }: SqlQueryOptions = {},
): Promise<SqlQueryResult> {
  if (!query.trim()) throw new SqlQueryError("The query is empty.");
  await client.exec("PRAGMA query_only = 1");
  try {
    let statement: Awaited<ReturnType<Database["prepare"]>>;
    try {
      statement = await client.prepare(query);
    } catch (err) {
      throw new SqlQueryError(errorMessage(err));
    }
    if (!statement.reader) {
      throw new SqlQueryError(
        "Only read-only queries that return rows (e.g. SELECT) are allowed.",
      );
    }
    const columns = statement.columns().map((c: { name: string }) => c.name);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    try {
      for await (const row of statement.iterate()) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(row as Record<string, unknown>);
      }
    } catch (err) {
      throw new SqlQueryError(errorMessage(err));
    }
    return { columns, rows, ...(truncated && { truncated }) };
  } finally {
    await client.exec("PRAGMA query_only = 0");
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
