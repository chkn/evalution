import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileScanner } from './file-scanner.ts';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('FileScanner', () => {
  let tempDir: string;
  let scanner: FileScanner;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evalution-test-'));
    scanner = new FileScanner();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should find .prompt.ts files recursively', async () => {
    await fs.mkdir(path.join(tempDir, 'subdir'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'test.prompt.ts'), '');
    await fs.writeFile(path.join(tempDir, 'subdir', 'nested.prompt.ts'), '');

    const files = await scanner.findPromptFiles(tempDir);

    expect(files).toHaveLength(2);
    expect(files.some(f => f.endsWith('test.prompt.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('nested.prompt.ts'))).toBe(true);
  });

  it('should find .promp.ts files (typo pattern)', async () => {
    await fs.writeFile(path.join(tempDir, 'typo.promp.ts'), '');

    const files = await scanner.findPromptFiles(tempDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('typo.promp.ts');
  });

  it('should ignore node_modules directory', async () => {
    await fs.mkdir(path.join(tempDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'node_modules', 'test.prompt.ts'), '');
    await fs.writeFile(path.join(tempDir, 'valid.prompt.ts'), '');

    const files = await scanner.findPromptFiles(tempDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('valid.prompt.ts');
  });

  it('should ignore dist directory', async () => {
    await fs.mkdir(path.join(tempDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'dist', 'test.prompt.ts'), '');
    await fs.writeFile(path.join(tempDir, 'valid.prompt.ts'), '');

    const files = await scanner.findPromptFiles(tempDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('valid.prompt.ts');
  });

  it('should ignore .git directory', async () => {
    await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.git', 'test.prompt.ts'), '');
    await fs.writeFile(path.join(tempDir, 'valid.prompt.ts'), '');

    const files = await scanner.findPromptFiles(tempDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain('valid.prompt.ts');
  });

  it('should return absolute paths', async () => {
    await fs.writeFile(path.join(tempDir, 'test.prompt.ts'), '');

    const files = await scanner.findPromptFiles(tempDir);

    expect(files).toHaveLength(1);
    expect(path.isAbsolute(files[0])).toBe(true);
  });

  it('should handle directories with no prompt files', async () => {
    await fs.writeFile(path.join(tempDir, 'regular.ts'), '');

    const files = await scanner.findPromptFiles(tempDir);

    expect(files).toHaveLength(0);
  });
});
