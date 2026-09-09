// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Node-side (fs-allowed) bootstrap for a local-first, optionally-synced Turso
 * client. Everything else in `src/trace/db/` is fs-free by construction; this
 * is deliberately the one place a real path gets involved — see
 * `specs/trace-workshopping.md` §B.3.
 */

import { connect, type Database } from "@tursodatabase/sync";

export interface LocalTursoClientOptions {
  /** Path to the local SQLite file (e.g. `<rootDir>/.evalution/trace.db`). */
  path: string;
  /**
   * Returns the cloud database URL once the user has signed up, or `null`
   * while signed out. Passing `url` as a *function* — rather than a plain
   * string — is what suppresses the SDK's remote bootstrap: it derives
   * `bootstrapIfEmpty` internally as `typeof opts.url != "function" ||
   * opts.url() != null`, so a function returning `null` keeps the database
   * purely local. Re-read on every sync operation, so flipping this from
   * `null` to a URL (after sign-up) switches sync on with no reconnect.
   * Defaults to an always-`null` function (never syncs).
   */
  getCloudUrl?: () => string | null;
  /**
   * Returns the bearer token for a sync operation. Not called until a sync
   * operation is attempted (`push`/`pull`), so a signed-out user never pays
   * for (or is prompted for) credentials they don't have.
   */
  getAuthToken?: () => Promise<string>;
  /** Identifies this client to the sync engine (shown in Turso's dashboard). */
  clientName?: string;
}

/**
 * Connects to a local SQLite database that starts purely local and, once
 * {@link LocalTursoClientOptions.getCloudUrl} starts returning a URL, syncs
 * to the cloud on the next `push`/`pull`.
 *
 * ⚠️ Per Turso's deferred-sync contract, encryption and other connection-time
 * parameters must be decided at this first connect — they cannot be
 * introduced later without re-bootstrapping the local database. This
 * project's posture is "none" for now; revisit before this ships with cloud
 * sync enabled.
 *
 * Callers still owe the database a migration pass (`runMigrations` from
 * `./migrate.ts`) before use — connecting alone does not create any tables.
 */
export async function createLocalTursoClient({
  path,
  getCloudUrl = () => null,
  getAuthToken,
  clientName = "evalution",
}: LocalTursoClientOptions): Promise<Database> {
  const db = await connect({
    path,
    url: getCloudUrl,
    ...(getAuthToken && { authToken: getAuthToken }),
    clientName,
  });
  // SQLite disables FK enforcement by default per-connection; the schema's
  // `ON DELETE CASCADE`s (see ./schema.ts) are inert without this.
  await db.exec("PRAGMA foreign_keys = ON");
  return db;
}
