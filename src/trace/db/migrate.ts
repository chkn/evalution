// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Applies `bundledMigrations` to a Drizzle `tursodatabase-sync`
 * database — fs-free, via `migrateAsync` rather than Drizzle's own `migrate()`
 * (which reads the migrations folder with `node:fs` and is therefore unusable
 * under Workers). See `specs/trace-workshopping.md` §B.4.
 */

import { migrateAsync } from "drizzle-orm/sqlite-core/async/session";
import { bundledMigrations } from "./migrations/bundled.ts";

/** The ledger table `runMigrations` records applied migrations in. */
export const MIGRATIONS_TABLE = "__evalution_migrations";

/**
 * Applies every migration in `bundledMigrations` that hasn't already
 * run, tracked in the {@link MIGRATIONS_TABLE} ledger. Idempotent: re-running
 * against an up-to-date database is a no-op. Called on local first-run and on
 * cloud provisioning alike (see §B.4) — never at import time, so a caller
 * controls exactly when the (transactional) DDL runs.
 */
export async function runMigrations(
  db: Parameters<typeof migrateAsync>[1],
): Promise<void> {
  await migrateAsync(bundledMigrations, db, {
    migrationsTable: MIGRATIONS_TABLE,
  });
}
