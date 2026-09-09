// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Guards against `migrations/bundled.ts` drifting from the actual migration
 * files — see `specs/trace-workshopping.md` §B.4.
 * `scripts/generate-migration-bundle.ts` is not run automatically on every
 * `drizzle-kit generate`, so this fails loudly (rather than silently shipping
 * stale, missing, or hand-edited migrations) if someone forgets the
 * `npm run db:bundle` step. Lives here rather than beside `bundled.ts`
 * because `migrations/` is excluded from biome's file set (see `biome.json`).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledMigrations } from "./migrations/bundled.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

describe("bundled migrations", () => {
  it("includes every migration directory on disk", () => {
    const dirs = readdirSync(MIGRATIONS_DIR)
      .filter(name => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
      .sort();
    const bundledNames = bundledMigrations.map(m => m.name).sort();
    expect(bundledNames).toEqual(dirs);
  });

  it("carries the on-disk hash and statements for each entry", () => {
    for (const migration of bundledMigrations) {
      const sql = migrationSql(migration.name);
      expect(createHash("sha256").update(sql).digest("hex")).toBe(
        migration.hash,
      );
      expect(migration.sql).toEqual(sql.split("--> statement-breakpoint"));
    }
  });
});
