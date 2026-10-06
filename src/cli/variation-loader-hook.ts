// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { createHash } from "node:crypto";
import module from "node:module";

/** The query parameter that carries a registered source's SHA-256. */
export const VARIATION_SOURCE_PARAM = "evalution-src";

const SOURCE_PATTERN = new RegExp(
  `[?&]${VARIATION_SOURCE_PARAM}=([0-9a-f]{64})(?:&|$)`,
);

/**
 * The hook's state, kept on `globalThis` rather than in module scope so every
 * copy of this module in the process shares it. There can be more than one:
 * the dev server runs the CLI from `src/` while a project's config imports
 * `evalution` from `dist/`, so the copy that registers the hook is not the
 * copy that `LocalFileProvider.importSource` checks and registers sources in.
 */
interface VariationLoaderState {
  /** Whether the load hook has been registered with Node. */
  registered: boolean;
  /** Registered sources by SHA-256. Content-addressed, so never stale. */
  sources: Map<string, string>;
}

const STATE_KEY = Symbol.for("evalution.variationLoader");

const scope = globalThis as { [STATE_KEY]?: VariationLoaderState };
scope[STATE_KEY] ??= { registered: false, sources: new Map() };
const state: VariationLoaderState = scope[STATE_KEY];

/**
 * Registers `source` for import and returns its SHA-256, to put in the
 * module URL's `?evalution-src=` query (see
 * {@link registerVariationLoaderHook}).
 */
export function registerVariationSource(source: string): string {
  const sha = createHash("sha256").update(source).digest("hex");
  state.sources.set(sha, source);
  return sha;
}

/** Whether {@link registerVariationLoaderHook} has run in this process. */
export function isVariationLoaderHookRegistered(): boolean {
  return state.registered;
}

/**
 * Registers an in-thread load hook that answers any module URL carrying
 * `?evalution-src=<sha256>` with the source registered under that hash —
 * which is how a prompt variation runs without its patched source ever
 * touching disk. See `specs/prompt-versions-and-variations.md` §H.
 *
 * The URL keeps the real file's path, so Node resolves the module's relative
 * imports against it: they land exactly where the real file's would. The
 * query also acts as the cache-buster: two variations of one file are two
 * URLs, and so two module instances.
 *
 * Uses `module.registerHooks` (synchronous, same-thread), like the other CLI
 * hooks. Registering twice is harmless, even from different copies of this
 * module.
 */
export function registerVariationLoaderHook(): void {
  if (state.registered) return;
  state.registered = true;
  module.registerHooks({
    load(url, context, nextLoad) {
      const match = SOURCE_PATTERN.exec(url);
      const source = match && state.sources.get(match[1]);
      if (source === undefined || source === null) {
        return nextLoad(url, context);
      }
      const path = url.split("?")[0];
      return {
        format: /\.[mc]?ts$/.test(path) ? "module-typescript" : "module",
        source,
        shortCircuit: true,
      };
    },
  });
}
