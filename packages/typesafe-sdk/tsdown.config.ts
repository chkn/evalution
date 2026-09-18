// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  outDir: "dist",
  dts: true,
  // Emit `.js`/`.d.ts` rather than tsdown's default `.mjs`/`.d.mts`.
  // The package is `"type": "module"`, so `.js` is already ESM, which keeps the
  // filenames referenced by `exports` stable.
  fixedExtension: false,
});
