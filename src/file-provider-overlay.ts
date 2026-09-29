// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  FileProvider,
  FileWatchCallback,
  FileWatchOptions,
  GlobOptions,
  ImportOptions,
} from "./file-provider.ts";

/**
 * A {@link FileProvider} that lays in-memory content over another one: for
 * an overlaid path, `readFile`, `writeFile` and `import` hit the overlay;
 * everything else passes through.
 *
 * This is how a prompt variation is materialized without touching disk: its
 * base content is overlaid at the prompt's **real** path, and the ordinary
 * edit pipeline applies the variation's updates to it there — so parsing sees
 * the patched text, and imports from it resolve as the real file's would.
 * See `specs/prompt-versions-and-variations.md` §H.
 */
export class OverlayFileProvider implements FileProvider {
  private readonly overlay = new Map<string, string>();

  /** The provider everything not overlaid passes through to. */
  readonly inner: FileProvider;

  /** @param inner - The provider everything not overlaid passes through to. */
  constructor(inner: FileProvider) {
    this.inner = inner;
  }

  /** Lays `content` over `filePath`. */
  set(filePath: string, content: string): void {
    this.overlay.set(filePath, content);
  }

  /** The overlaid content at `filePath`, if any. */
  get(filePath: string): string | undefined {
    return this.overlay.get(filePath);
  }

  /** Removes every overlay, so everything passes through again. */
  clear(): void {
    this.overlay.clear();
  }

  async readFile(filePath: string): Promise<string> {
    const content = this.overlay.get(filePath);
    return content ?? this.inner.readFile(filePath);
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (this.overlay.has(filePath)) this.overlay.set(filePath, content);
    else await this.inner.writeFile(filePath, content);
  }

  async deleteFile(filePath: string): Promise<void> {
    if (this.overlay.has(filePath)) this.overlay.delete(filePath);
    else await this.inner.deleteFile(filePath);
  }

  async import(filePath: string, options?: ImportOptions): Promise<any> {
    const content = this.overlay.get(filePath);
    if (content === undefined) return this.inner.import(filePath, options);
    return this.importSource(filePath, content);
  }

  async importSource(filePath: string, source: string): Promise<any> {
    if (!this.inner.importSource) {
      throw new Error(
        "This file provider can't import a module from memory, so prompt " +
          "variations can't be run with it.",
      );
    }
    return this.inner.importSource(filePath, source);
  }

  glob(pattern: string, options?: GlobOptions): AsyncIterableIterator<string> {
    return this.inner.glob(pattern, options);
  }

  watch(
    patterns: readonly string[],
    options: FileWatchOptions,
    callback: FileWatchCallback,
  ): () => void {
    return this.inner.watch(patterns, options, callback);
  }
}
