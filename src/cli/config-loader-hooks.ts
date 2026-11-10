// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import module from "node:module";

/**
 * Registers an in-thread module-resolution hook so a project's
 * `.evalution/config.ts` can import the framework by bare specifier
 * (`import { FilePromptProvider } from 'evalution'`) regardless of where it
 * lives or whether evalution is installed in the project's `node_modules`.
 *
 * By default Node resolves `evalution` against the config file's directory,
 * which fails when evalution is run via `npx` (or pointed at another directory)
 * and isn't installed locally. This hook redirects the `evalution` specifier
 * (and its subpaths) to resolve from the running CLI instead, so the config
 * always binds to the same evalution the CLI is executing — no local install
 * required. The same goes for `@evalution/sdk`, and for the packages an adapter
 * expects its host to provide (see {@link ADAPTER_PEERS}).
 *
 * Uses {@link https://nodejs.org/api/module.html#moduleregisterhooksoptions | `module.registerHooks`}
 * (synchronous, same-thread) rather than `module.register`, so it needs no
 * separate loader file — it survives bundling and behaves identically whether
 * the CLI runs from source (dev) or the compiled bundle (published).
 *
 * @param parentURL - Module URL the `evalution` specifier is resolved against;
 *   pass the CLI's own `import.meta.url`.
 */
export function registerEvalutionResolver(parentURL: string): void {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isCliOwned(specifier)) {
        return nextResolve(specifier, { ...context, parentURL });
      }
      if (!ADAPTER_PEERS.has(specifier)) {
        return nextResolve(specifier, context);
      }
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        try {
          return nextResolve(specifier, { ...context, parentURL });
        } catch {
          // Not in the CLI either: report the original failure.
          throw err;
        }
      }
    },
  });
}

/**
 * Packages always bound to the running CLI's copy. An adapter package installed
 * in the project depends on `@evalution/sdk` too, and under `npx` that would
 * otherwise be a second copy of it.
 */
function isCliOwned(specifier: string): boolean {
  return ["evalution", "@evalution/sdk"].some(
    name => specifier === name || specifier.startsWith(`${name}/`),
  );
}

/**
 * Optional peers of the adapter packages' `/config` entries. They stay optional
 * so a production install of an adapter doesn't pull in the TypeScript
 * compiler, so a project may not have them; the CLI always does.
 */
const ADAPTER_PEERS = new Set(["typescript", "ts-proppy"]);
