// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hookUrl = new URL('./config-loader-hooks.ts', import.meta.url).href;

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Builds a self-contained fixture: a fake `evalution` package in one location
 * and a project config (with no local `node_modules`) that imports it by bare
 * specifier. Returns a runner script that imports the config, optionally with
 * the resolve hook registered.
 */
async function makeFixture(withHook: boolean): Promise<{ runner: string; cwd: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evalution-resolve-'));
  tmpDirs.push(root);

  // A fake "evalution" package, living where the project can't see it.
  const pkgDir = path.join(root, 'cli-install', 'node_modules', 'evalution');
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'evalution', type: 'module', exports: './index.js' }),
  );
  await fs.writeFile(path.join(pkgDir, 'index.js'), 'export class FilePromptProvider {}\n');

  // A project config importing the framework by bare specifier. The project dir
  // deliberately has no node_modules, so this only resolves via the hook.
  const cwd = path.join(root, 'project');
  const configPath = path.join(cwd, '.evalution', 'config.ts');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    "import { FilePromptProvider } from 'evalution';\n" +
      "export default { ok: typeof FilePromptProvider === 'function' };\n",
  );

  const anchor = pathToFileURL(path.join(pkgDir, 'index.js')).href;
  const register = withHook
    ? `import { registerEvalutionResolver } from ${JSON.stringify(hookUrl)};\n` +
      `registerEvalutionResolver(${JSON.stringify(anchor)});\n`
    : '';

  const runner = path.join(root, 'runner.mjs');
  await fs.writeFile(
    runner,
    register +
      `const mod = await import(${JSON.stringify(pathToFileURL(configPath).href)});\n` +
      `console.log(JSON.stringify(mod.default));\n`,
  );

  return { runner, cwd };
}

describe('config-loader-hooks', () => {
  it('resolves a bare `evalution` import from the CLI, not the project dir', async () => {
    const { runner, cwd } = await makeFixture(true);
    const out = execFileSync(process.execPath, [runner], { cwd, encoding: 'utf8' });
    expect(out.trim()).toBe('{"ok":true}');
  });

  it('fails without the hook, proving the hook is what makes it resolve', async () => {
    const { runner, cwd } = await makeFixture(false);
    expect(() => execFileSync(process.execPath, [runner], { cwd, stdio: 'pipe' }))
      .toThrow(/Cannot find package 'evalution'/);
  });
});
