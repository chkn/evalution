// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { defineConfig } from '@playwright/experimental-ct-react';

export default defineConfig({
  testDir: 'src',
  testMatch: '**/*.pw.tsx',
  use: {
    ctPort: 3101,
    ctViteConfig: {
      resolve: {
        alias: {},
      },
    },
  },
});
