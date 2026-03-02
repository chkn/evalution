import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { glob as globLib } from 'fs/promises';
import { makeRe, minimatch } from 'minimatch';
import chokidar from 'chokidar';
import type { ChangeEventType } from '../prompt-provider.ts';

export interface GlobOptions {
  cwd?: string;
  ignore?: readonly string[];
  absolute?: boolean;
}

export interface FileWatchOptions {
  cwd?: string;
  ignored?: readonly string[];
  ignoreInitial?: boolean;
}

export type FileWatchCallback = (eventType: ChangeEventType, filePath: string) => void;

export interface FileProvider {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  import(filePath: string): Promise<any>;
  glob(pattern: string, options?: GlobOptions): AsyncIterableIterator<string>;
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

export class MemoryFileProvider implements FileProvider {
  private files: Map<string, string>;
  private watchers: Set<MemoryWatcher> = new Set();

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
