# Evalution

Evalution is a local-first development tool. Maintain your prompts directly in your codebase, and
use the web playground to edit parameters, switch models, and see results in real
time, so what you test is exactly what ships.

📖 **Documentation: [evalut.io/n/docs](https://evalut.io/n/docs)**

## Features

- 🔍 **Auto-discovery** — scans your project for `.prompt.ts` files
- 🔄 **Always in sync** — edit prompts in the UI or directly in the source files; they always stay in sync
- 🎯 **Type-safe** — full TypeScript support with parameter inference
- 🔌 **Multi-provider** — Vercel AI SDK is fully supported, or wire up a different SDK adapter
- 📊 **Tracing** — traces for your prompt runs populate in realtime
- 🤖 **MCP server** — `npx evalution mcp` lets coding agents run prompts, query traces with SQL, annotate them, and build datasets
- 🧩 **Extensible** — swap in your own prompt sources, SDK adapters, and trace backends

## Getting started

Run this in the root of your project:

```sh
npx evalution
```

Requires Node.js 22.18.0 or higher.

See the [documentation](https://evalut.io/n/docs) for more detailed guidance.

## Development

1. Install dependencies: `pnpm install`
2. Run server and client against the evalution check out: `pnpm run dev`
3. Run against a different path:

```sh
pnpm run dev:server ui <path>
pnpm run dev:client
```
Other useful commands:

- `pnpm test` — run unit tests (`pnpm run test:coverage` for coverage)
- `pnpm run test:ui` — run Playwright component tests
- `pnpm run typecheck` — type-check the project
- `pnpm run docs` — regenerate the API reference
- `pnpm run build` — build the server and client

## License

AGPL
