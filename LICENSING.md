# Licensing

This document is an informal explainer. The binding terms are in
[`LICENSE`](./LICENSE), [`LICENSE.addendum`](./LICENSE.addendum), and the
per-package `LICENSE` files. Where this document and those files disagree,
those files win.

## Short version

| You want to…                                                              | What applies                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Run evalution locally (`npx evalution`), including with any providers     | Free. No source-sharing obligation.                       |
| Modify evalution and keep it to yourself                                  | Free. No obligation until you distribute or host it.      |
| Distribute a modified evalution                                           | AGPL-3.0: ship your source under the AGPL.                |
| **Host** evalution as a network service (SaaS)                            | AGPL-3.0 §13: offer the full source — **including any providers loaded through its config** — to your users. |
| Write a provider/extension and distribute it separately                   | Free. License it however you like (see below).            |
| Use `@evalution/vercel-ai-sdk` in your own project                        | MIT. Use it anywhere, including closed-source.             |

## The core: AGPL-3.0-only + a section 7 addendum

The `evalution` core is licensed **AGPL-3.0-only** ([`LICENSE`](./LICENSE))
with additional terms under section 7 ([`LICENSE.addendum`](./LICENSE.addendum)).

The addendum draws a deliberate line around **Providers** — separately
distributed works that implement evalution's `PromptProvider` / `TraceProvider`
interfaces and are loaded at runtime through `.evalution/config.ts`:

- **Run locally**, a Provider is *not* pulled under the AGPL. Anyone may write
  one, license it under any license (MIT, proprietary, anything), distribute it
  on its own, and have others depend on it and load it into a local `npx`
  invocation. This is an *additional permission* the addendum grants.

- **Hosted over a network**, that permission does not apply, and baseline AGPL
  reasserts: any Provider loaded through the config becomes part of the covered
  work, so a network operator must offer its Corresponding Source to remote
  users under §13. In practice this means you cannot host evalution with a
  closed-source provider loaded — you must be able to provide that provider's
  source.

The net effect, by design: provider authors stay free; people self-hosting for
themselves stay free; only operators turning evalution + providers into a
network service take on the source-sharing obligation.

## The Vercel AI SDK adapter: MIT

[`packages/vercel-ai-sdk`](./packages/vercel-ai-sdk) (`@evalution/vercel-ai-sdk`)
is **MIT** ([`LICENSE`](./packages/vercel-ai-sdk/LICENSE)) so it can be imported
into any project, including closed-source ones, without AGPL obligations.

For that promise to be real, the package's published `dist` must contain only
permissively licensed code:

- The package takes **no runtime dependency** on the AGPL core — only
  `peerDependencies` on `ai` and the `@ai-sdk/*` packages.
- It does bundle one file from the core,
  [`src/trace/prompt-tracer.ts`](./src/trace/prompt-tracer.ts), via the build.
  That file is **dual-licensed `MIT OR AGPL-3.0-only`** (see its SPDX header),
  so the bytes that land in the MIT package are genuinely MIT.
- `prompt-tracer.ts` must stay **self-contained** (only `@opentelemetry/api`).
  If it ever imports from elsewhere in the core, the bundler would pull
  AGPL-only code into the MIT artifact and break this guarantee.

## Contributing

Contributions to this repository require a signed Contributor License Agreement
([`CLA.md`](./CLA.md)). The CLA lets the project keep offering the core under
the AGPL while preserving the maintainer's ability to dual-license, ship the
MIT adapter, and operate a hosted service. You keep the copyright to your
contribution; you grant a broad license to use it.
