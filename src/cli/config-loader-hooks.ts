// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
 * required.
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
      if (specifier === "evalution" || specifier.startsWith("evalution/")) {
        return nextResolve(specifier, { ...context, parentURL });
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * Packages evalution imports lazily but does not own: they are optional peer
 * dependencies belonging to the consumer's project, and execution must run
 * against the consumer's own copy (the same instance their provider/model
 * objects were built with).
 */
const PEER_DEPENDENCIES = ["ai", "@google/genai"];

function isPeerDependency(specifier: string): boolean {
  return PEER_DEPENDENCIES.some(
    name => specifier === name || specifier.startsWith(`${name}/`),
  );
}

/**
 * Registers an in-thread module-resolution hook that lets evalution's lazy
 * `import('ai')` / `import('@google/genai')` find those packages in the user's
 * project when they are not resolvable from evalution itself.
 *
 * This is the mirror image of {@link registerEvalutionResolver}. Both packages
 * are *optional* peer dependencies, which npm deliberately does not install —
 * so under `npx evalution` they are absent from the CLI's own `node_modules`
 * and a bare `import('ai')` from the bundle fails with `ERR_MODULE_NOT_FOUND`
 * even though the project it was pointed at has `ai` installed.
 *
 * The retry only runs after normal resolution has already failed, so a project
 * that resolves these packages on its own (the common case, including a
 * workspace that pins its own copy) keeps the exact resolution it has today.
 *
 * @param projectDir - Directory to retry resolution from; pass the root dir the
 *   CLI is serving (the one holding `.evalution/config.ts`).
 */
export function registerPeerDependencyResolver(projectDir: string): void {
  // Any filename inside the project works as an anchor: Node resolves a bare
  // specifier by walking `node_modules` up from the parent's directory, and
  // never reads the parent itself.
  const parentURL = pathToFileURL(
    path.join(projectDir, "[evalution-peer-resolver]"),
  ).href;

  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!isPeerDependency(specifier)) return nextResolve(specifier, context);
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        try {
          return nextResolve(specifier, { ...context, parentURL });
        } catch {
          // Not in the project either — report the original failure rather
          // than the retry's, which points at a directory the user never named.
          throw err;
        }
      }
    },
  });
}
