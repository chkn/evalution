import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { glob as globLib } from 'fs/promises';
import { makeRe, minimatch } from 'minimatch';
import chokidar from 'chokidar';
import type { ChangeEventType } from '../prompt-provider.ts';

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
export type FileWatchCallback = (eventType: ChangeEventType, filePath: string) => void;

/**
 * Abstraction over file system I/O used throughout evalution.
 *
 * Swap in a different implementation to adapt evalution to non-local
 * environments or to make tests fully in-memory (see {@link MemoryFileProvider}).
 * {@link LocalFileProvider} is the default implementation for production use.
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
    callback: FileWatchCallback
  ): () => void;
}

interface MemoryWatcher {
  patterns: readonly string[];
  cwd: string;
  ignored: readonly string[];
  callback: FileWatchCallback;
}

/**
 * An in-memory {@link FileProvider} backed by a `Map<string, string>`.
 *
 * Intended for unit tests — all file I/O stays in-process with no disk access.
 * Calling {@link writeFile} triggers any active {@link watch} callbacks
 * synchronously, making it easy to test reactive code paths.
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
    this.notifyWatchers(isNew ? 'add' : 'change', filePath);
  }

  async import(filePath: string): Promise<any> {
    const content = this.files.get(filePath);
    if (content === undefined) throw new Error(`File not found: ${filePath}`);
    return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(content)}`);
  }

  async* glob(pattern: string, options: GlobOptions = {}): AsyncIterableIterator<string> {
    const { cwd = process.cwd(), ignore = [], absolute = false } = options;

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(cwd + path.sep)) continue;
      const relativePath = path.relative(cwd, filePath).replace(/\\/g, '/');
      if (!minimatch(relativePath, pattern)) continue;
      if (ignore.some(p => minimatch(relativePath, p))) continue;
      yield absolute ? filePath : relativePath;
    }
  }

  watch(
    patterns: readonly string[],
    options: FileWatchOptions,
    callback: FileWatchCallback
  ): () => void {
    const watcher: MemoryWatcher = {
      patterns,
      cwd: options.cwd ?? process.cwd(),
      ignored: options.ignored ?? [],
      callback,
    };
    this.watchers.add(watcher);
    return () => { this.watchers.delete(watcher); };
  }

  private notifyWatchers(eventType: ChangeEventType, filePath: string): void {
    for (const watcher of this.watchers) {
      const { cwd, patterns, ignored, callback } = watcher;
      if (!filePath.startsWith(cwd + path.sep)) continue;
      const relativePath = path.relative(cwd, filePath).replace(/\\/g, '/');
      if (!patterns.some(p => minimatch(relativePath, p))) continue;
      if (ignored.some(p => minimatch(relativePath, p))) continue;
      callback(eventType, relativePath);
    }
  }
}

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
    return fs.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async import(filePath: string): Promise<any> {
    return import(pathToFileURL(filePath).href);
  }

  async* glob(pattern: string, options: GlobOptions = {}): AsyncIterableIterator<string> {
    const { cwd, ignore = [], absolute = false } = options;
    const baseCwd = cwd ?? process.cwd();

    for await (const file of globLib(pattern, { cwd: baseCwd })) {
      const relativePath = file.replace(/\\/g, '/');
      if (ignore.some(p => minimatch(relativePath, p))) continue;
      yield absolute ? path.resolve(baseCwd, file) : file;
    }
  }

  watch(
    patterns: readonly string[],
    options: FileWatchOptions,
    callback: FileWatchCallback
  ): () => void {
    const includeMatchers = patterns.map(p => makeRe(p)).filter(re => re !== false);
    const ignoreMatchers = options.ignored?.map(p => makeRe(p)).filter(re => re !== false);
    const matches = (fp: string) => includeMatchers.some(re => re.test(fp));

    const watcher = chokidar.watch('.', {
      cwd: options.cwd,
      ignored: ignoreMatchers,
      persistent: true,
      ignoreInitial: options.ignoreInitial ?? true,
    });

    watcher.on('change', (fp) => { if (matches(fp)) callback('change', fp); });
    watcher.on('add', (fp) => { if (matches(fp)) callback('add', fp); });
    watcher.on('unlink', (fp) => { if (matches(fp)) callback('remove', fp); });

    return () => watcher.close();
  }
}
