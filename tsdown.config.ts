// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli/index.ts", "src/index.ts"],
  format: "esm",
  outDir: "dist",
  dts: true,
  deps: {
    neverBundle: [
      "typescript",
      "ai",
      "@google/genai",
      "@typesafe-ai/sdk",
      "chokidar",
      "minimatch",
      // Native (napi) module: its binding loader `require`s a per-platform
      // `@tursodatabase/sync-<platform>` package at module scope, which only
      // resolves from an installed `node_modules` tree — inlining it into the
      // bundle would make `dist/cli/index.js` throw on import.
      "@tursodatabase/sync",
      "drizzle-orm",
    ],
  },
  // Emit `.js`/`.d.ts` rather than tsdown's default `.mjs`/`.d.mts`.
  // The package is `"type": "module"`, so `.js` is already ESM, which keeps the
  // filenames referenced by `exports` and `bin/evalution.js` stable.
  fixedExtension: false,
});
