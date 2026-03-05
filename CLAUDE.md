# Development

- Always use `npm run typecheck` instead of running `tsc` directly. The project has a separate client tsconfig (`tsconfig.client.json`) that `npm run typecheck` runs in addition to the default.
- Run `npm test` regularly to catch regressions.
- Run `npm run docs` after changing public APIs. Fix any warnings — all exported types, interfaces, and classes must have doc comments.
