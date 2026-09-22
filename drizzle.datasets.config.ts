// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "drizzle-kit";

// The dataset twin of `drizzle.config.ts` — `drizzle-kit generate` only; the
// runtime applies `src/dataset/db/migrations/bundled.ts` via `migrateAsync`.
// See `specs/datasets.md` §F.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/dataset/db/schema.ts",
  out: "./src/dataset/db/migrations",
});
