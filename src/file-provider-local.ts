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

  async import(filePath: string): Promise<any> {
    return import(pathToFileURL(filePath).href);
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
