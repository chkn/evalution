// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs, { glob as globLib } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chokidar from "chokidar";
import { makeRe, minimatch } from "minimatch";
import {
  GENERATION_PARAM,
  importGeneration,
  isFreshImportHookRegistered,
  markImportFailed,
} from "./cli/fresh-import-hook.ts";
import {
  isVariationLoaderHookRegistered,
  registerVariationSource,
  VARIATION_SOURCE_PARAM,
} from "./cli/variation-loader-hook.ts";
import type {
  FileProvider,
  FileWatchCallback,
  FileWatchOptions,
  GlobOptions,
  ImportOptions,
} from "./file-provider.ts";

/**
 * A {@link FileProvider} backed by the local file system.
 *
 * Uses `fs/promises` for I/O, `fs/promises.glob` (Node.js ≥ 22) for pattern
 * matching, and [chokidar](https://github.com/paulmillr/chokidar) for file
 * watching.
 *
 * This is the default implementation used by {@link FilePromptProvider} and
 * {@link TSPromptFileType} when no custom provider is supplied.
 */
export class LocalFileProvider implements FileProvider {
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }

  async deleteFile(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  /**
   * Whether the host rejected a cache-busting query string, so we stop adding
   * one. Node accepts `file:///x.ts?mtime=1` and treats it as a distinct module,
   * but a transform pipeline in front of it may read the extension off the
   * whole specifier and choke on `.ts?mtime=1`.
   */
  #cacheBustingUnsupported = false;

  /**
   * With the fresh-import hook registered (see `registerFreshImportHook`),
   * every import is made in the current generation, and a fresh one first
   * starts a new generation if anything loaded in it has changed — so what the
   * module imports by path is fresh too, and a plain import of a module hands
   * back the same instance its importers got. Without the hook, a fresh import
   * busts only the module itself.
   */
  async import(filePath: string, { fresh }: ImportOptions = {}): Promise<any> {
    const plain = pathToFileURL(filePath).href;
    if (this.#cacheBustingUnsupported) return import(plain);

    const url = pathToFileURL(filePath);
    if (isFreshImportHookRegistered()) {
      url.search = `?${GENERATION_PARAM}=${await importGeneration(!!fresh)}`;
    } else if (fresh) {
      // mtime rather than a counter, so an unchanged file still hits the
      // cache. Integer nanoseconds, not the fractional `mtimeMs`: a loader that
      // reads the extension off the whole specifier sees `?x=1.5` as a `.5`
      // file. And not `?v=` or `?t=`, which Vite reserves and strips before
      // its module cache.
      const { mtimeNs } = await fs.stat(filePath, { bigint: true });
      url.search = `?mtime=${mtimeNs}`;
    } else {
      return import(plain);
    }

    try {
      return await import(url.href);
    } catch (err) {
      // Either the host can't take the query, or the module itself threw.
      // Retrying plain tells the two apart — with the hook, nothing imports
      // the plain URL otherwise, so this is its first evaluation rather than a
      // cached old version: if it also throws, that is the real error; if it
      // succeeds, the host is the problem, and this instance stops trying (at
      // the cost of staleness, which beats not loading at all).
      const loaded = await import(plain).catch(() => {
        // Node caches the failure along with the module: the next fresh
        // import has to be made in a new generation to retry it.
        markImportFailed();
        throw err;
      });
      this.#cacheBustingUnsupported = true;
      console.warn(
        `⚠️ ${filePath} only loads without a cache-busting query, so changes to it, ` +
          "or to modules it imports, won't be picked up until you restart evalution:",
        err,
      );
      return loaded;
    }
  }

  /**
   * Imports `source` under the real file's URL plus `?evalution-src=<sha256>`,
   * which the variation load hook answers with `source` (see
   * `registerVariationLoaderHook`). Node resolves the module's relative
   * imports against the URL's path, so they land where the real file's would.
   */
  async importSource(filePath: string, source: string): Promise<any> {
    if (!isVariationLoaderHookRegistered()) {
      throw new Error(
        "Running a prompt variation needs evalution's module loader hook, " +
          "which is registered by the evalution CLI. Call " +
          "`registerVariationLoaderHook()` first when running prompts from " +
          "your own process.",
      );
    }
    if (this.#cacheBustingUnsupported) {
      throw new Error(
        "This host's module loader rejects query strings on imports, so " +
          "prompt variations can't be run here. Save the variation to the " +
          "file to run it.",
      );
    }
    const url = pathToFileURL(filePath);
    url.search = `?${VARIATION_SOURCE_PARAM}=${registerVariationSource(source)}`;
    // In the current generation, so what the variation imports is as fresh as
    // what the file on disk would get.
    if (isFreshImportHookRegistered()) {
      url.searchParams.set(
        GENERATION_PARAM,
        String(await importGeneration(true)),
      );
    }
    return import(url.href);
  }

  async *glob(
    pattern: string,
    options: GlobOptions = {},
  ): AsyncIterableIterator<string> {
    const { cwd, ignore = [], absolute = false } = options;
    const baseCwd = cwd ?? process.cwd();

    for await (const file of globLib(pattern, { cwd: baseCwd })) {
      const relativePath = file.replace(/\\/g, "/");
      if (ignore.some(p => minimatch(relativePath, p, { dot: true }))) continue;
      yield absolute ? path.resolve(baseCwd, file) : file;
    }
  }

  watch(
    patterns: readonly string[],
    options: FileWatchOptions,
    callback: FileWatchCallback,
  ): () => void {
    const cwd = options.cwd ?? process.cwd();
    const ignored = options.ignored ?? [];
    const includeMatchers = patterns
      .map(p => makeRe(p))
      .filter((re): re is RegExp => re !== false);
    const matches = (fp: string) => includeMatchers.some(re => re.test(fp));

    const watcher = chokidar.watch(".", {
      cwd,
      // chokidar tests `ignored` against absolute paths; convert to relative before matching
      ignored: (absPath: string) => {
        const rel = path.relative(cwd, absPath).replace(/\\/g, "/");
        return ignored.some(p => minimatch(rel, p, { dot: true }));
      },
      persistent: true,
      ignoreInitial: options.ignoreInitial ?? true,
    });

    watcher.on("change", fp => {
      if (matches(fp)) callback("change", fp);
    });
    watcher.on("add", fp => {
      if (matches(fp)) callback("add", fp);
    });
    watcher.on("unlink", fp => {
      if (matches(fp)) callback("remove", fp);
    });
    // Without a listener an error (e.g. EMFILE on a huge tree) is rethrown and
    // crashes the process; losing live updates is better than losing the server.
    watcher.on("error", err => {
      console.warn(`file watcher error in ${cwd}:`, err);
    });

    return () => {
      watcher.close();
    };
  }
}
