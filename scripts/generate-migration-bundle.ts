// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Bundles the SQL migrations `npm run db:generate` (`drizzle-kit generate`)
 * writes under `src/trace/db/migrations/` into a fs-free TS `MigrationMeta[]`
 * constant (`src/trace/db/migrations/bundled.ts`), so the runtime can apply
 * them via `drizzle-orm/sqlite-core/async/session`'s `migrateAsync` without
 * ever touching the filesystem — required for a Workers bundle. See
 * `specs/trace-workshopping.md` §B.4.
 *
 * Mirrors `drizzle-orm`'s own (fs-based, therefore Workers-unusable)
 * `readMigrationFiles` exactly, so the hashes/names it computes match what a
 * future `drizzle-kit`-driven flow would: each migration directory's name is
 * `<14-digit timestamp>_<slug>`, its `migration.sql` is split on
 * `--> statement-breakpoint`, and its hash is a sha256 of the raw file
 * content.
 *
 * Usage: `npm run db:bundle`, after `npm run db:generate`.
 *
 * ⚠️ Migrations are append-only once shipped. `migrateAsync` decides what to
 * apply by comparing each bundled migration's `name` against the ledger, so
 * regenerating an already-released migration (deleting its directory and
 * re-running `db:generate`, which mints a fresh timestamped name) makes every
 * existing database try to re-run its DDL and fail with "table already
 * exists". Change the schema by adding a new migration, never by rewriting
 * one that has been out in the world.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "../src/trace/db/migrations");
const OUT_FILE = join(MIGRATIONS_DIR, "bundled.ts");

function formatToMillis(dateStr: string): number {
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  const month = Number.parseInt(dateStr.slice(4, 6), 10) - 1;
  const day = Number.parseInt(dateStr.slice(6, 8), 10);
  const hour = Number.parseInt(dateStr.slice(8, 10), 10);
  const minute = Number.parseInt(dateStr.slice(10, 12), 10);
  const second = Number.parseInt(dateStr.slice(12, 14), 10);
  return Date.UTC(year, month, day, hour, minute, second);
}

const dirs = readdirSync(MIGRATIONS_DIR)
  .filter(name => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
  .sort((a, b) => a.localeCompare(b));

if (dirs.length === 0) {
  throw new Error(
    `No migration directories found in ${MIGRATIONS_DIR} — run \`npm run db:generate\` first.`,
  );
}

const migrations = dirs.map(name => {
  const query = readFileSync(
    join(MIGRATIONS_DIR, name, "migration.sql"),
    "utf8",
  );
  return {
    name,
    hash: createHash("sha256").update(query).digest("hex"),
    folderMillis: formatToMillis(name.slice(0, 14)),
    bps: true,
    sql: query.split("--> statement-breakpoint"),
  };
});

const contents = `// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

// GENERATED FILE — do not edit by hand. Regenerate with
// \`npm run db:generate && npm run db:bundle\`
// (see scripts/generate-migration-bundle.ts).

import type { MigrationMeta } from "drizzle-orm/migrator";

/** Every migration under \`src/trace/db/migrations/\`, in apply order. */
export const bundledMigrations: MigrationMeta[] = ${JSON.stringify(migrations, null, 2)};
`;

writeFileSync(OUT_FILE, contents);
console.log(`Wrote ${migrations.length} migration(s) to ${OUT_FILE}`);
