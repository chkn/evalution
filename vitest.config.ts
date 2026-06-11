// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "src/parser/**",
        "src/cli/**",
        "src/providers/**",
        "src/server/**",
      ],
      exclude: ["**/*.test.ts", "**/__fixtures__/**"],
    },
  },
});
