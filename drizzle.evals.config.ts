// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "drizzle-kit";

// The eval-store twin of `drizzle.config.ts` — `drizzle-kit generate` only;
// the runtime applies `src/eval/db/migrations/bundled.ts` via
// `migrateAsync`. See `specs/evals.md` §E.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/eval/db/schema.ts",
  out: "./src/eval/db/migrations",
});
