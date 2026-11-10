// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Client `.tsx` files are compiled with the automatic JSX runtime
  // (`tsconfig.client.json`); the root tsconfig vitest reads doesn't say so.
  esbuild: { jsx: "automatic" },
  // Workspace packages resolve to their TypeScript source, not a build.
  resolve: { conditions: ["evalution-source"] },
  test: {
    globals: true,
    environment: "node",
    // Tests must not find a developer's own portkit and send it traces.
    env: { PORTKIT_HOME: "/nonexistent/portkit" },
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
