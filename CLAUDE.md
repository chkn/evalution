# Development

- Always use `npm run typecheck` instead of running `tsc` directly. The project has a separate client tsconfig (`tsconfig.client.json`) that `npm run typecheck` runs in addition to the default.
- Run `npm test` regularly to catch regressions.
- Run `npm run test:ui` to run Playwright component tests (UI behaviour, rendered widths, cursor position, etc.).
- Run `npm run docs` after changing public APIs. Fix any warnings — all exported types, interfaces, and classes must have doc comments.

# Testing

Every new feature and every bug fix must ship with a test. Prefer unit tests (`vitest`, `src/**/*.test.ts`) — they run faster and are easier to debug. Use Playwright component tests (`npm run test:ui`, `src/**/*.pw.tsx`) only when the behaviour cannot be verified without a real browser (e.g. DOM layout, contentEditable cursor position, drag-and-drop).

For tests that touch files, use `MemoryFileProvider` (`src/file-provider-memory.ts`) and inject it via the `fileProvider` option rather than writing to a temp dir on disk — it keeps I/O in-process (faster, no cleanup) and fires watch callbacks synchronously, so reactive paths can be tested without `setTimeout` waits. Reach for the real filesystem / `LocalFileProvider` only when the test genuinely exercises real-FS behaviour (e.g. chokidar watching, dynamic `import`/package resolution, reading committed `__fixtures__`).

When writing Playwright component tests:
- Define any React components used by the test in a separate story file (e.g. `FooHarness.tsx`) and import them — Playwright CT does not allow components defined inside the test file itself.
- Extract repeated browser-side logic (e.g. cursor-offset measurement) into a shared helper function rather than copy-pasting it.
