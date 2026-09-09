// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only — schema/migrations are hand-verified and the
// runtime never reads this file (or the filesystem) directly. See
// `specs/trace-workshopping.md` §B.4: migrations are bundled into
// `src/trace/db/migrations/bundled.ts` at build time and applied via
// fs-free `migrateAsync`, not `drizzle-kit migrate`/`push`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/trace/db/schema.ts",
  out: "./src/trace/db/migrations",
});
