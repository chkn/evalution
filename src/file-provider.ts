// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ChangeEventType } from "./shared/types.ts";

/** Options accepted by {@link FileProvider.glob}. */
export interface GlobOptions {
  /** The directory to search from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Glob patterns whose matches are excluded from results. */
  ignore?: readonly string[];
  /** When `true`, yielded paths are absolute; otherwise they are relative to `cwd`. */
  absolute?: boolean;
}

/** Options accepted by {@link FileProvider.watch}. */
export interface FileWatchOptions {
  /** The directory from which relative file paths are resolved. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Glob patterns whose matches are excluded from the watcher. */
  ignored?: readonly string[];
  /**
   * When `true`, the watcher does not emit events for files that already exist
   * at startup. Defaults to `true`.
   */
  ignoreInitial?: boolean;
}

/**
 * Callback invoked by {@link FileProvider.watch} when a watched file changes.
 * @param eventType - The kind of change: `'add'`, `'change'`, or `'remove'`.
 * @param filePath - The affected file path, relative to the watcher's `cwd`.
 */
export type FileWatchCallback = (
  eventType: ChangeEventType,
  filePath: string,
) => void;

/**
 * Abstraction over file system I/O used throughout Evalution.
 *
 * Swap in a different implementation to adapt Evalution to non-local
 * environments or to make tests fully in-memory. The
 * {@link MemoryFileProvider} (in `./file-provider-memory.ts`) keeps everything
 * in-process with no Node-only dependencies; {@link LocalFileProvider} (in
 * `./file-provider-local.ts`) is the default implementation for production use.
 */
export interface FileProvider {
  /**
   * Reads the file at `filePath` and returns its content as a UTF-8 string.
   * Rejects if the file does not exist.
   */
  readFile(filePath: string): Promise<string>;

  /**
   * Writes `content` to `filePath`, creating or overwriting the file.
   * When the path falls inside an active {@link watch} scope, the watcher
   * callback is invoked automatically.
   */
  writeFile(filePath: string, content: string): Promise<void>;

  /**
   * Deletes the file at `filePath`.
   * When the path falls inside an active {@link watch} scope, the watcher
   * callback is invoked automatically with `'remove'`.
   */
  deleteFile(filePath: string): Promise<void>;

  /**
   * Dynamically imports the module at `filePath` and returns its namespace
   * object. Rejects if the file does not exist.
   */
  import(filePath: string): Promise<any>;

  /**
   * Returns an async iterator that yields paths matching `pattern`.
   * @param pattern - A glob pattern (e.g. `'**\/*.prompt.ts'`).
   * @param options - See {@link GlobOptions}.
   */
  glob(pattern: string, options?: GlobOptions): AsyncIterableIterator<string>;

  /**
   * Starts watching for changes to files that match `patterns` and calls
   * `callback` on each relevant event.
   *
   * @param patterns - Glob patterns that select which files to watch.
   * @param options - See {@link FileWatchOptions}.
   * @param callback - Called for each matching file event.
   * @returns A cleanup function; call it to stop watching.
   */
  watch(
    patterns: readonly string[],
    options: FileWatchOptions,
    callback: FileWatchCallback,
  ): () => void;
}
