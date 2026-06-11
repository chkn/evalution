# Contributing to evalution

Thanks for your interest in contributing!

## Contributor License Agreement

Before your contribution can be merged, you must agree to the
[Contributor License Agreement](./CLA.md). You keep the copyright to your work;
the CLA grants the project the rights it needs to keep offering the core under
the AGPL while shipping the MIT adapter and operating a hosted service. Indicate
your acceptance as described in [`CLA.md`](./CLA.md).

## Licensing

How the code is licensed — AGPL-3.0 core, the section 7 Provider addendum, and
the MIT `@evalution/vercel-ai-sdk` adapter — is explained in
[`LICENSING.md`](./LICENSING.md). If you touch
[`src/trace/prompt-tracer.ts`](./src/trace/prompt-tracer.ts), note its
dual-license header and keep it self-contained.

## Development

See [`README.md`](./README.md) for the day-to-day workflow. In short:

- `npm run typecheck` — type-check (runs the client tsconfig too; use this, not `tsc`).
- `npm test` — unit tests (vitest). Run regularly.
- `npm run test:ui` — Playwright component tests, for behaviour that needs a real browser.
- `npm run docs` — regenerate docs after changing public APIs; fix any warnings.

Every new feature and every bug fix should ship with a test — prefer fast unit
tests, and reach for Playwright component tests only when the behaviour can't be
verified without a browser.
