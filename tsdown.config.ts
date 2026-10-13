// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/cli/index.ts", "src/index.ts", "src/checks/index.ts"],
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
  },
  // The views runtime and its entries (`evalution/views`, `/react`,
  // `/datasets`), which views' bundles are built against. Browser code:
  // checked with the client's DOM/JSX config, and React is never bundled —
  // it comes from the project a view is built in.
  {
    entry: {
      "views/index": "src/views/index.ts",
      "views/react/index": "src/views/react/index.tsx",
      "views/datasets/index": "src/views/datasets/index.ts",
    },
    format: "esm",
    outDir: "dist",
    clean: false,
    dts: true,
    tsconfig: "tsconfig.client.json",
    platform: "browser",
    deps: {
      neverBundle: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react-dom/client",
      ],
    },
    fixedExtension: false,
  },
]);
