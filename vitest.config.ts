import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/parser/**', 'src/cli/**', 'src/providers/**', 'src/server/**'],
      exclude: ['**/*.test.ts', '**/__fixtures__/**'],
    },
  },
});
