// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs";
import module from "node:module";
import { fileURLToPath } from "node:url";
import { isFileSpecifier } from "./bundler-resolution-hook.ts";

/** The query parameter that carries the generation a module was imported in. */
export const GENERATION_PARAM = "evalution-gen";

const GENERATION_PATTERN = new RegExp(`[?&]${GENERATION_PARAM}=(\\d+)(?:&|$)`);

/**
 * The hook's state, kept on `globalThis` rather than in module scope so every
 * copy of this module in the process shares it: the dev server registers the
 * hook from `src/` while a project's config gets its `LocalFileProvider` from
 * `dist/` (see `./variation-loader-hook.ts`).
 */
interface FreshImportState {
  /** Whether the hooks have been registered with Node. */
  registered: boolean;
  /** The generation fresh imports are currently made in. */
  generation: number;
  /** Every file loaded in the current generation, with its mtime when it was. */
  loaded: Map<string, bigint>;
  /** Set when an import in the current generation failed: Node caches the failure. */
  failed: boolean;
}

const STATE_KEY = Symbol.for("evalution.freshImport");

const scope = globalThis as { [STATE_KEY]?: FreshImportState };
scope[STATE_KEY] ??= {
  registered: false,
  generation: 0,
  loaded: new Map(),
  failed: false,
};
const state: FreshImportState = scope[STATE_KEY];

/** Whether {@link registerFreshImportHook} has run in this process. */
export function isFreshImportHookRegistered(): boolean {
  return state.registered;
}

/**
 * The generation to import in. With `check`, a new one if any file loaded in
 * the current generation has changed since (or an import in it failed), so a
 * fresh import picks up an edit anywhere in what it imports; otherwise the
 * current one, so an unchanged module graph is not evaluated again.
 */
export async function importGeneration(check: boolean): Promise<number> {
  const observed = state.generation;
  if (!check) return observed;
  const loaded = [...state.loaded];
  const now = await Promise.all(
    loaded.map(([file]) =>
      fs.promises.stat(file, { bigint: true }).then(
        s => s.mtimeNs,
        () => undefined,
      ),
    ),
  );
  const stale =
    state.failed || now.some((mtimeNs, i) => mtimeNs !== loaded[i][1]);
  // A concurrent check may have moved on already: one new generation, not two.
  if (stale && state.generation === observed) {
    state.generation++;
    state.loaded = new Map();
    state.failed = false;
  }
  return state.generation;
}

/** Notes that an import in the current generation failed, so the next fresh import starts a new one. */
export function markImportFailed(): void {
  state.failed = true;
}

/**
 * Registers in-thread hooks that make a fresh import fresh all the way down.
 *
 * Node caches an ES module by URL for the life of the process. A fresh import
 * of `db.ts` is made as `db.ts?evalution-gen=N`, and the resolve hook gives
 * every file it imports by path the same `?evalution-gen=N` — so an edited
 * dependency is reloaded along with the module, and two modules that import
 * each other within a generation share one instance of it. The load hook
 * records each file loaded in the current generation, with its mtime, which
 * is how `importGeneration` knows when to start a new one.
 *
 * Only imports by path are followed: packages, imported by name — including
 * `evalution` itself, which the CLI resolves to its own files — keep a single
 * instance, as does anything under `node_modules`.
 *
 * Uses `module.registerHooks` (synchronous, same-thread), like the other CLI
 * hooks. Registering twice is harmless, even from different copies of this
 * module.
 */
export function registerFreshImportHook(): void {
  if (state.registered) return;
  state.registered = true;
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const generation =
        context.parentURL && GENERATION_PATTERN.exec(context.parentURL)?.[1];
      if (
        !generation ||
        !isFileSpecifier(specifier) ||
        !context.conditions?.includes("import") ||
        !resolved.url.startsWith("file:") ||
        resolved.url.includes("/node_modules/")
      ) {
        return resolved;
      }
      const url = new URL(resolved.url);
      url.searchParams.set(GENERATION_PARAM, generation);
      return { ...resolved, url: url.href };
    },
    load(url, context, nextLoad) {
      const generation = GENERATION_PATTERN.exec(url)?.[1];
      if (
        generation !== undefined &&
        Number(generation) === state.generation &&
        url.startsWith("file:")
      ) {
        // Before the load reads the file, so an edit racing it reads as newer.
        const file = fileURLToPath(url);
        try {
          state.loaded.set(file, fs.statSync(file, { bigint: true }).mtimeNs);
        } catch {
          // Unreadable: the load itself will say so.
        }
      }
      return nextLoad(url, context);
    },
  });
}
