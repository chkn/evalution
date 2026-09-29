// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { createHash } from "node:crypto";
import module from "node:module";

/** The query parameter that carries a registered source's SHA-256. */
export const VARIATION_SOURCE_PARAM = "evalution-src";

const SOURCE_PATTERN = new RegExp(
  `[?&]${VARIATION_SOURCE_PARAM}=([0-9a-f]{64})(?:&|$)`,
);

/** Registered sources by SHA-256. Content-addressed, so never stale. */
const sources = new Map<string, string>();

let registered = false;

/**
 * Registers `source` for import and returns its SHA-256, to put in the
 * module URL's `?evalution-src=` query (see
 * {@link registerVariationLoaderHook}).
 */
export function registerVariationSource(source: string): string {
  const sha = createHash("sha256").update(source).digest("hex");
  sources.set(sha, source);
  return sha;
}

/** Whether {@link registerVariationLoaderHook} has run in this process. */
export function isVariationLoaderHookRegistered(): boolean {
  return registered;
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
 * hooks. Registering twice is harmless.
 */
export function registerVariationLoaderHook(): void {
  if (registered) return;
  registered = true;
  module.registerHooks({
    load(url, context, nextLoad) {
      const match = SOURCE_PATTERN.exec(url);
      const source = match && sources.get(match[1]);
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
