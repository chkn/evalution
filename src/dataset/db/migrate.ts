// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Applies the dataset schema's bundled migrations — the dataset twin of
 * `src/trace/db/migrate.ts`, sharing its fs-free runner and ledger table.
 */

import { runMigrations } from "../../trace/db/migrate.ts";
import { bundledMigrations } from "./migrations/bundled.ts";

/**
 * Applies every dataset migration that hasn't already run. Idempotent. Call
 * before constructing a {@link TursoDatasetProvider} over the same client.
 */
export async function runDatasetMigrations(
  db: Parameters<typeof runMigrations>[0],
): Promise<void> {
  await runMigrations(db, bundledMigrations);
}
