import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scaffoldConfigFile } from './scaffold-config.ts';
import { CONFIG_FILE_RELATIVE_PATH, configFileTemplate } from '../shared/config-template.ts';

describe('scaffoldConfigFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'evalution-scaffold-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes the config file with the chosen SDK template', async () => {
    const result = await scaffoldConfigFile(root, 'vercel-ai-sdk');
    expect(result).toEqual({ path: CONFIG_FILE_RELATIVE_PATH, created: true });

    const written = await fs.readFile(path.join(root, CONFIG_FILE_RELATIVE_PATH), 'utf8');
    expect(written).toBe(configFileTemplate('vercel-ai-sdk'));
  });

  it('creates the .evalution directory when missing', async () => {
    await scaffoldConfigFile(root, 'other');
    const stat = await fs.stat(path.join(root, '.evalution'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('refuses to overwrite an existing config file', async () => {
    await scaffoldConfigFile(root, 'vercel-ai-sdk');
    await expect(scaffoldConfigFile(root, 'other')).rejects.toThrow('already exists');

    // The original (Vercel) template must be left intact.
    const written = await fs.readFile(path.join(root, CONFIG_FILE_RELATIVE_PATH), 'utf8');
    expect(written).toBe(configFileTemplate('vercel-ai-sdk'));
  });
});
