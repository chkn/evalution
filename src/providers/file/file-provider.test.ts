import { describe, it, expect } from 'vitest';
import { MemoryFileProvider } from './file-provider.ts';

const cwd = '/virtual';

describe('MemoryFileProvider', () => {
  describe('readFile', () => {
    it('returns content for a known path', async () => {
      const provider = new MemoryFileProvider({ '/virtual/foo.ts': 'hello' });
      expect(await provider.readFile('/virtual/foo.ts')).toBe('hello');
    });

    it('throws for an unknown path', async () => {
      const provider = new MemoryFileProvider();
      await expect(provider.readFile('/virtual/missing.ts')).rejects.toThrow('File not found');
    });
  });

  describe('writeFile', () => {
    it('stores content readable via readFile', async () => {
      const provider = new MemoryFileProvider();
      await provider.writeFile('/virtual/foo.ts', 'content');
      expect(await provider.readFile('/virtual/foo.ts')).toBe('content');
    });

    it('overwrites existing content', async () => {
      const provider = new MemoryFileProvider({ '/virtual/foo.ts': 'old' });
      await provider.writeFile('/virtual/foo.ts', 'new');
      expect(await provider.readFile('/virtual/foo.ts')).toBe('new');
    });
  });

  describe('import', () => {
    it('imports module exports from in-memory content', async () => {
      const provider = new MemoryFileProvider({
        '/virtual/mod.js': 'export const value = 42; export function double(x) { return x * 2; }',
      });
      const mod = await provider.import('/virtual/mod.js');
      expect(mod.value).toBe(42);
      expect(mod.double(5)).toBe(10);
    });

    it('throws for an unknown path', async () => {
      const provider = new MemoryFileProvider();
      await expect(provider.import('/virtual/missing.js')).rejects.toThrow('File not found');
    });
  });

  describe('glob', () => {
    it('matches files by extension pattern', async () => {
      const provider = new MemoryFileProvider({
        '/virtual/a.ts': '',
        '/virtual/b.ts': '',
        '/virtual/c.js': '',
      });
      const files = await Array.fromAsync(provider.glob('*.ts', { cwd }));
      expect(files).toEqual(['a.ts', 'b.ts']);
    });

    it('supports recursive ** patterns', async () => {
      const provider = new MemoryFileProvider({
        '/virtual/a.ts': '',
        '/virtual/sub/b.ts': '',
        '/virtual/sub/deep/c.ts': '',
      });
      const files = await Array.fromAsync(provider.glob('**/*.ts', { cwd }));
      expect(files).toEqual(['a.ts', 'sub/b.ts', 'sub/deep/c.ts']);
    });

    it('excludes files outside cwd', async () => {
      const provider = new MemoryFileProvider({
        '/virtual/a.ts': '',
        '/other/b.ts': '',
      });
      const files = await Array.fromAsync(provider.glob('**/*.ts', { cwd }));
      expect(files).toEqual(['a.ts']);
    });

    it('respects ignore patterns', async () => {
      const provider = new MemoryFileProvider({
        '/virtual/a.ts': '',
        '/virtual/node_modules/b.ts': '',
        '/virtual/dist/c.ts': '',
      });
      const files = await Array.fromAsync(provider.glob('**/*.ts', { cwd, ignore: ['node_modules/**', 'dist/**'] }));
      expect(files).toEqual(['a.ts']);
    });

    it('returns absolute paths when absolute: true', async () => {
      const provider = new MemoryFileProvider({
        '/virtual/a.ts': '',
        '/virtual/b.ts': '',
      });
      const files = await Array.fromAsync(provider.glob('*.ts', { cwd, absolute: true }));
      expect(files).toEqual(['/virtual/a.ts', '/virtual/b.ts']);
    });

    it('returns empty array when no files match', async () => {
      const provider = new MemoryFileProvider({ '/virtual/a.js': '' });
      const files = await Array.fromAsync(provider.glob('*.ts', { cwd }));
      expect(files).toEqual([]);
    });
  });

  describe('watch', () => {
    it('calls callback with "add" when a new file is written', async () => {
      const provider = new MemoryFileProvider();
      const events: [string, string][] = [];
      provider.watch(['**/*.ts'], { cwd }, (type, fp) => events.push([type, fp]));

      await provider.writeFile('/virtual/a.ts', 'hello');

      expect(events).toEqual([['add', 'a.ts']]);
    });

    it('calls callback with "change" when an existing file is overwritten', async () => {
      const provider = new MemoryFileProvider({ '/virtual/a.ts': 'old' });
      const events: [string, string][] = [];
      provider.watch(['**/*.ts'], { cwd }, (type, fp) => events.push([type, fp]));

      await provider.writeFile('/virtual/a.ts', 'new');

      expect(events).toEqual([['change', 'a.ts']]);
    });

    it('only fires for files matching the include patterns', async () => {
      const provider = new MemoryFileProvider();
      const events: [string, string][] = [];
      provider.watch(['**/*.prompt.ts'], { cwd }, (type, fp) => events.push([type, fp]));

      await provider.writeFile('/virtual/a.prompt.ts', 'x');
      await provider.writeFile('/virtual/b.ts', 'y');

      expect(events).toEqual([['add', 'a.prompt.ts']]);
    });

    it('excludes files matching ignored patterns', async () => {
      const provider = new MemoryFileProvider();
      const events: [string, string][] = [];
      provider.watch(['**/*.ts'], { cwd, ignored: ['node_modules/**'] }, (type, fp) => events.push([type, fp]));

      await provider.writeFile('/virtual/a.ts', 'x');
      await provider.writeFile('/virtual/node_modules/b.ts', 'y');

      expect(events).toEqual([['add', 'a.ts']]);
    });

    it('ignores files outside the cwd', async () => {
      const provider = new MemoryFileProvider();
      const events: [string, string][] = [];
      provider.watch(['**/*.ts'], { cwd }, (type, fp) => events.push([type, fp]));

      await provider.writeFile('/other/a.ts', 'x');

      expect(events).toEqual([]);
    });

    it('stops firing after cleanup is called', async () => {
      const provider = new MemoryFileProvider();
      const events: [string, string][] = [];
      const cleanup = provider.watch(['**/*.ts'], { cwd }, (type, fp) => events.push([type, fp]));

      await provider.writeFile('/virtual/a.ts', 'x');
      cleanup();
      await provider.writeFile('/virtual/b.ts', 'y');

      expect(events).toEqual([['add', 'a.ts']]);
    });

    it('supports multiple concurrent watchers', async () => {
      const provider = new MemoryFileProvider();
      const events1: [string, string][] = [];
      const events2: [string, string][] = [];
      provider.watch(['**/*.ts'], { cwd }, (type, fp) => events1.push([type, fp]));
      provider.watch(['**/*.js'], { cwd }, (type, fp) => events2.push([type, fp]));

      await provider.writeFile('/virtual/a.ts', 'x');
      await provider.writeFile('/virtual/b.js', 'y');

      expect(events1).toEqual([['add', 'a.ts']]);
      expect(events2).toEqual([['add', 'b.js']]);
    });
  });
});
