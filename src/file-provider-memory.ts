// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { minimatch } from "minimatch";
import type { ChangeEventType } from "./shared/types.ts";
import type {
  FileProvider,
  FileWatchCallback,
  FileWatchOptions,
  GlobOptions,
} from "./file-provider.ts";

interface MemoryWatcher {
  patterns: readonly string[];
  cwd: string;
  ignored: readonly string[];
  callback: FileWatchCallback;
}

/**
 * An in-memory {@link FileProvider} backed by a `Map<string, string>`.
 *
 * Intended for unit tests and non-local environments (e.g. a browser or
 * service-worker bundle) — all file I/O stays in-process with no disk access.
 * It depends only on `node:path` and `minimatch`, so it carries no Node-only
 * runtime dependencies (no `node:fs`, `chokidar`, etc.). Calling
 * {@link writeFile} triggers any active {@link watch} callbacks synchronously,
 * making it easy to test reactive code paths.
 *
 * @example
 * ```ts
 * const provider = new MemoryFileProvider({
 *   '/virtual/prompt.ts': 'export function myPrompt() { ... }',
 * });
 * const content = await provider.readFile('/virtual/prompt.ts');
 * ```
 */
export class MemoryFileProvider implements FileProvider {
  private files: Map<string, string>;
  private watchers: Set<MemoryWatcher> = new Set();

  /**
   * @param files - Initial file contents keyed by absolute path.
   */
  constructor(files: Record<string, string> = {}) {
    this.files = new Map(Object.entries(files));
  }

  async readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined) throw new Error(`File not found: ${filePath}`);
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const isNew = !this.files.has(filePath);
    this.files.set(filePath, content);
    this.notifyWatchers(isNew ? "add" : "change", filePath);
  }

  async deleteFile(filePath: string): Promise<void> {
    this.files.delete(filePath);
    this.notifyWatchers("remove", filePath);
  }

  async import(filePath: string): Promise<any> {
    const content = this.files.get(filePath);
    if (content === undefined) throw new Error(`File not found: ${filePath}`);
    return import(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(content)}`
    );
  }

  async *glob(
    pattern: string,
    options: GlobOptions = {},
  ): AsyncIterableIterator<string> {
    const { cwd = process.cwd(), ignore = [], absolute = false } = options;

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(cwd + path.sep)) continue;
      const relativePath = path.relative(cwd, filePath).replace(/\\/g, "/");
      if (!minimatch(relativePath, pattern)) continue;
      if (ignore.some(p => minimatch(relativePath, p))) continue;
      yield absolute ? filePath : relativePath;
    }
  }

  watch(
    patterns: readonly string[],
    options: FileWatchOptions,
    callback: FileWatchCallback,
  ): () => void {
    const watcher: MemoryWatcher = {
      patterns,
      cwd: options.cwd ?? process.cwd(),
      ignored: options.ignored ?? [],
      callback,
    };
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  private notifyWatchers(eventType: ChangeEventType, filePath: string): void {
    for (const watcher of this.watchers) {
      const { cwd, patterns, ignored, callback } = watcher;
      if (!filePath.startsWith(cwd + path.sep)) continue;
      const relativePath = path.relative(cwd, filePath).replace(/\\/g, "/");
      if (!patterns.some(p => minimatch(relativePath, p))) continue;
      if (ignored.some(p => minimatch(relativePath, p))) continue;
      callback(eventType, relativePath);
    }
  }
}
