// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "drizzle-kit";

// The variation-store twin of `drizzle.config.ts` — `drizzle-kit generate`
// only; the runtime applies `src/prompt/variations/db/migrations/bundled.ts`
// via `migrateAsync`. See `specs/prompt-versions-and-variations.md` §E.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/prompt/variations/db/schema.ts",
  out: "./src/prompt/variations/db/migrations",
});
