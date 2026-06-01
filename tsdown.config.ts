import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli/index.ts', 'src/index.ts'],
  format: 'esm',
  outDir: 'dist',
  dts: true,
  deps: {
    neverBundle: ['typescript', 'ai', 'fastify', 'chokidar', 'minimatch', 'pino-pretty'],
  },
  // Emit `.js`/`.d.ts` rather than tsdown's default `.mjs`/`.d.mts`.
  // The package is `"type": "module"`, so `.js` is already ESM, which keeps the
  // filenames referenced by `exports` and `bin/evalution.js` stable.
  fixedExtension: false,
});
