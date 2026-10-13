// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig, devices } from "@playwright/experimental-ct-react";

/** Tests whose guarantees each browser enforces itself: view sandboxing. */
const CROSS_BROWSER = "**/views.pw.tsx";

export default defineConfig({
  testDir: "src",
  testMatch: "**/*.pw.tsx",
  use: {
    ctPort: 3101,
    ctViteConfig: {
      resolve: {
        alias: {},
      },
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // A view's frame is kept from navigating away by the page's `frame-src`,
    // which each browser enforces on its own (specs/trace-visualizers.md
    // §B.3), so those tests run in all three.
    {
      name: "firefox",
      testMatch: CROSS_BROWSER,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testMatch: CROSS_BROWSER,
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
