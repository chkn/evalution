// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchForConfigCreation } from './config-watcher.ts';

const stops: Array<() => void> = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evalution-cw-'));
  tmpDirs.push(dir);
  return dir;
}

/** Resolves when `watchForConfigCreation` fires, or rejects after `ms`. */
function waitForCreation(rootDir: string, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watcher did not fire')), ms);
    const stop = watchForConfigCreation(rootDir, () => {
      clearTimeout(timer);
      resolve();
    });
    stops.push(stop);
  });
}

describe('watchForConfigCreation', () => {
  it('fires when .evalution/config.ts is created (dir did not exist)', async () => {
    const rootDir = await makeTmpDir();
    const fired = waitForCreation(rootDir);

    // Let chokidar finish its initial scan; otherwise the creation is folded
    // into the initial state and suppressed by `ignoreInitial`. In real usage
    // the config is written long after the watcher is established.
    await new Promise((r) => setTimeout(r, 500));

    const configPath = path.join(rootDir, '.evalution', 'config.ts');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'export default {};', 'utf8');

    await expect(fired).resolves.toBeUndefined();
  });

  it('ignores unrelated files created under the root', async () => {
    const rootDir = await makeTmpDir();
    let fired = false;
    const stop = watchForConfigCreation(rootDir, () => { fired = true; });
    stops.push(stop);

    await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'README.md'), '# hi', 'utf8');
    await fs.writeFile(path.join(rootDir, 'src', 'index.ts'), 'export {};', 'utf8');

    // Give the watcher a moment to (not) react.
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(false);
  });

  it('swallows a rejected callback and retries on the next change', async () => {
    const rootDir = await makeTmpDir();
    const configPath = path.join(rootDir, '.evalution', 'config.ts');

    let calls = 0;
    const secondCall = new Promise<void>((resolve) => {
      const stop = watchForConfigCreation(rootDir, async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom on first load');
        resolve();
      });
      stops.push(stop);
    });

    await new Promise((r) => setTimeout(r, 500));

    // First write fails inside the callback; the rejection must not escape.
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'export default {};', 'utf8');

    // Editing the file re-fires the watcher, proving it kept watching.
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(configPath, 'export default { a: 1 };', 'utf8');

    await expect(secondCall).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
