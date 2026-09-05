// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs, { glob as globLib } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import chokidar from "chokidar";
import { makeRe, minimatch } from "minimatch";
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
   * one. Node accepts `file:///x.ts?v=1` and treats it as a distinct module,
   * but a transform pipeline in front of it may read the extension off the
   * whole specifier and choke on `.ts?v=1`.
   */
  #cacheBustingUnsupported = false;

  async import(filePath: string, { fresh }: ImportOptions = {}): Promise<any> {
    const plain = pathToFileURL(filePath).href;
    if (!fresh || this.#cacheBustingUnsupported) return import(plain);

    // A distinct specifier is the only way past Node's module cache. mtime
    // rather than a counter, so an unchanged file still hits the cache.
    const { mtimeMs } = await fs.stat(filePath);
    const url = pathToFileURL(filePath);
    url.search = `?v=${mtimeMs}`;

    try {
      return await import(url.href);
    } catch (err) {
      // Either the host can't take the query, or the module itself threw.
      // Retrying plain tells the two apart: if it also throws, that is the
      // real error and worth surfacing; if it succeeds, the host is the
      // problem and this instance stops trying (at the cost of staleness,
      // which beats not loading at all).
      const loaded = await import(plain).catch(() => {
        throw err;
      });
      this.#cacheBustingUnsupported = true;
      return loaded;
    }
  }

  async *glob(
    pattern: string,
    options: GlobOptions = {},
  ): AsyncIterableIterator<string> {
    const { cwd, ignore = [], absolute = false } = options;
    const baseCwd = cwd ?? process.cwd();

    for await (const file of globLib(pattern, { cwd: baseCwd })) {
      const relativePath = file.replace(/\\/g, "/");
      if (ignore.some(p => minimatch(relativePath, p))) continue;
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

    return () => {
      watcher.close();
    };
  }
}
