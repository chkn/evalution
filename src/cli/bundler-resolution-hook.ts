// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import module from "node:module";

const RESOLVABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function isFileSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file://")
  );
}

function candidateSpecifiers(specifier: string): string[] {
  return [
    ...RESOLVABLE_EXTENSIONS.map(ext => specifier + ext),
    ...RESOLVABLE_EXTENSIONS.map(ext => `${specifier}/index${ext}`),
  ];
}

/**
 * Registers an in-thread module-resolution hook that falls back to
 * bundler-style resolution — appending an extension (`./foo` → `./foo.ts`)
 * or a directory's index file (`./tools` → `./tools/index.ts`) — when
 * Node's strict ESM resolver rejects a relative or absolute specifier that
 * has neither.
 *
 * Prompt files (and whatever they import) run through Node's own loader,
 * but consumer projects are commonly authored for a bundler
 * (`moduleResolution: "bundler"`), which allows omitting both. Only retried
 * for specifiers Node itself couldn't resolve, and only for relative or
 * absolute ones — bare package specifiers are left to normal resolution.
 */
export function registerBundlerResolutionFallback(): void {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!isFileSpecifier(specifier)) return nextResolve(specifier, context);
      try {
        return nextResolve(specifier, context);
      } catch (err: any) {
        if (
          err?.code !== "ERR_MODULE_NOT_FOUND" &&
          err?.code !== "ERR_UNSUPPORTED_DIR_IMPORT"
        ) {
          throw err;
        }
        for (const candidate of candidateSpecifiers(specifier)) {
          try {
            return nextResolve(candidate, context);
          } catch {
            // Try the next candidate.
          }
        }
        throw err;
      }
    },
  });
}
