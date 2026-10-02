// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runs caller-written SQL against a local database file on a worker thread,
 * with a time limit.
 *
 * `runReadOnlyQuery` caps how many rows come back, not how much work a query
 * does, and the Turso binding steps a query synchronously on the thread that
 * runs it: an aggregate over a large join would block the event loop — and
 * with it the playground, trace ingestion and every other request — until it
 * finished, possibly never. The binding's own query timeouts don't interrupt
 * it (as of `@tursodatabase/sync` 0.7), so the query runs on a worker thread
 * with its own connection instead, and the caller gets an error once
 * `timeoutMs` passes.
 *
 * A worker blocked inside the native step can't be stopped early: it is told
 * to terminate, and does once the step returns. Until then it holds a CPU
 * core, so at most {@link MAX_RUNAWAY_QUERIES} such queries may be left
 * running before new ones are refused.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  DEFAULT_MAX_QUERY_ROWS,
  DEFAULT_QUERY_TIMEOUT_MS,
  SqlQueryError,
  type SqlQueryOptions,
  type SqlQueryResult,
} from "./read-only-query.ts";

/** How many timed-out queries may still be running before new ones are refused. */
export const MAX_RUNAWAY_QUERIES = 2;

let runaway = 0;

/** How many queries have timed out but are still running. */
export function runawayQueryCount(): number {
  return runaway;
}

/**
 * The worker's whole program. Mirrors `runReadOnlyQuery`, on a connection of
 * its own that stays in `query_only` mode for its short life. The connection
 * is a plain one, without the sync engine the store's own connection runs:
 * several sync-engine connections opening one file at once fail with
 * "database is busy". A statement
 * that returns no rows (which covers a `PRAGMA query_only = 0` smuggled in as
 * the statement) is refused, and only the first statement is ever prepared.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { moduleUrl, path, sql, maxRows } = workerData;
(async () => {
  let db;
  try {
    const { connect } = await import(moduleUrl);
    db = await connect({ path });
    await db.exec("PRAGMA query_only = 1");
  } catch (err) {
    parentPort.postMessage({ error: String(err && err.message || err), internal: true });
    return;
  }
  try {
    const statement = await db.prepare(sql);
    if (!statement.reader) {
      parentPort.postMessage({
        error: "Only read-only queries that return rows (e.g. SELECT) are allowed.",
      });
      return;
    }
    const columns = statement.columns().map(c => c.name);
    const rows = [];
    let truncated = false;
    for await (const row of statement.iterate()) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    parentPort.postMessage({ result: { columns, rows, ...(truncated && { truncated }) } });
  } catch (err) {
    parentPort.postMessage({ error: String(err && err.message || err) });
  } finally {
    await db.close().catch(() => {});
  }
})();
`;

let exitHooked = false;

/**
 * Node waits for every worker to stop before the process can exit, and a
 * worker stuck in a native step won't, so a timed-out query still running
 * would keep `process.exit()` (Ctrl-C included) from ever finishing. Once
 * that's possible, the process instead kills itself on exit if one is left,
 * after the `exit` listeners registered before this one have run.
 */
function exitDespiteRunaways(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    if (runaway > 0) process.kill(process.pid, "SIGKILL");
  });
}

let moduleUrl: string | undefined;

/** Where the worker imports the Turso binding from: this package's own copy, wherever the worker's cwd is. */
function tursoModuleUrl(): string {
  moduleUrl ??= pathToFileURL(
    createRequire(import.meta.url).resolve("@tursodatabase/sync"),
  ).href;
  return moduleUrl;
}

type WorkerMessage =
  | { result: SqlQueryResult }
  | { error: string; internal?: boolean };

/**
 * Runs one read-only, row-returning query against the database file at
 * `path` on a worker thread, returning at most `maxRows` rows. Throws a
 * {@link SqlQueryError} if the query is refused, fails, or runs past
 * `timeoutMs`.
 */
export function runQueryInWorker(
  path: string,
  sql: string,
  {
    maxRows = DEFAULT_MAX_QUERY_ROWS,
    timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  }: SqlQueryOptions = {},
): Promise<SqlQueryResult> {
  if (!sql.trim()) {
    return Promise.reject(new SqlQueryError("The query is empty."));
  }
  if (runaway >= MAX_RUNAWAY_QUERIES) {
    return Promise.reject(
      new SqlQueryError(
        "Earlier queries that timed out are still running, so no new query can start until they finish. Try again later.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { moduleUrl: tursoModuleUrl(), path, sql, maxRows },
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new SqlQueryError(
            `The query took longer than ${timeoutMs / 1000} s and was stopped. Narrow it down, e.g. with a WHERE clause or fewer joins.`,
          ),
        ),
      );
      // Stuck in a native step, the worker can't stop until the step
      // returns; count it until it does, and don't let it hold the process
      // open meanwhile.
      runaway++;
      worker.once("exit", () => runaway--);
      exitDespiteRunaways();
      worker.unref();
      void worker.terminate();
    }, timeoutMs);
    worker.once("message", (message: WorkerMessage) =>
      settle(() => {
        if ("result" in message) resolve(message.result);
        else if (message.internal) reject(new Error(message.error));
        else reject(new SqlQueryError(message.error));
      }),
    );
    worker.once("error", err => settle(() => reject(err)));
    worker.once("exit", code =>
      settle(() =>
        reject(new Error(`The query worker exited with code ${code}`)),
      ),
    );
  });
}
