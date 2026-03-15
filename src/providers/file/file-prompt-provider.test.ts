import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FilePromptProvider } from './file-prompt-provider.ts';
import { MemoryFileProvider } from './file-provider.ts';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('FilePromptProvider', () => {
  let tempDir: string;
  let provider: FilePromptProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evalution-provider-test-'));
    provider = new FilePromptProvider({ rootDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return all prompts from all files', async () => {
    await fs.writeFile(path.join(tempDir, 'test1.prompt.ts'), `
export function prompt1() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test 1'
  };
}
`);

    await fs.writeFile(path.join(tempDir, 'test2.prompt.ts'), `
export function prompt2() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test 2'
  };
}
`);

    const prompts = await provider.getAllPrompts();

    expect(prompts).toHaveLength(2);
    expect(prompts.some(p => p.name === 'prompt1')).toBe(true);
    expect(prompts.some(p => p.name === 'prompt2')).toBe(true);
  });

  it('should return specific prompt by ID', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);

    const promptId = `test.prompt.ts#myPrompt`;
    const prompt = await provider.getPrompt(promptId);

    expect(prompt).not.toBeNull();
    expect(prompt!.name).toBe('myPrompt');
    expect(prompt!.id).toBe(promptId);
  });

  it('should return null for non-existent ID', async () => {
    const prompt = await provider.getPrompt('/fake/path.ts#nonexistent');

    expect(prompt).toBeNull();
  });

  it('should update editable property', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Old value'
  };
}
`);

    const promptId = `${filePath}#myPrompt`;
    const updatedPrompt = await provider.updatePromptProperties(promptId, {
      system: 'New value',
    });

    expect(updatedPrompt.properties.system.value).toBe('New value');

    const fileContent = await fs.readFile(filePath, 'utf-8');
    expect(fileContent).toContain('"New value"');
  });

  it('should return updated sourceText on model property after mode switch', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
import { openai } from '@ai-sdk/openai';

export function myPrompt() {
  return {
    model: openai('gpt-4o'),
    system: 'Test'
  };
}
`);

    const promptId = `${filePath}#myPrompt`;
    const updatedPrompt = await provider.updatePromptProperties(promptId, {
      model: { type: 'string', provider: 'openai', model: 'gpt-4o' },
    });

    expect(updatedPrompt.properties.model.sourceText).toBe('"openai/gpt-4o"');
  });

  it('should throw error for read-only property', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
function getDynamic() {
  return 'dynamic';
}

export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: getDynamic()
  };
}
`);

    const promptId = `${filePath}#myPrompt`;

    await expect(
      provider.updatePromptProperties(promptId, { system: 'New' })
    ).rejects.toThrow('not editable');
  });

  it('should throw error for non-existent prompt', async () => {
    await expect(
      provider.updatePromptProperties('/fake/path.ts#fake', { system: 'New' })
    ).rejects.toThrow('Prompt not found');
  });

  it('should add a new property when key does not exist', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);

    const promptId = `${filePath}#myPrompt`;

    const updated = await provider.updatePromptProperties(promptId, { temperature: 0.7 });
    expect(updated.properties['temperature']).toBeDefined();
    expect(updated.properties['temperature'].value).toBe(0.7);
  });

  it('should support watching', () => {
    expect(provider.watch).toBeDefined();
  });

  it('should support editing', () => {
    expect(provider.updatePromptProperties).toBeDefined();
  });

  it('should handle files with multiple exported functions correctly', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function prompt1() {
  return {
    model: 'openai/gpt-4o',
    system: 'First'
  };
}

export function prompt2() {
  return {
    model: 'openai/gpt-4o',
    system: 'Second'
  };
}
`);

    const prompts = await provider.getAllPrompts();

    expect(prompts).toHaveLength(2);
    expect(prompts[0].name).toBe('prompt1');
    expect(prompts[1].name).toBe('prompt2');
  });

  it('should re-parse file after update to return fresh data', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Original'
  };
}
`);

    const promptId = `${filePath}#myPrompt`;

    // First update
    await provider.updatePromptProperties(promptId, { system: 'Updated' });

    // Verify fresh data
    const prompt = await provider.getPrompt(promptId);
    expect(prompt!.properties.system.value).toBe('Updated');
  });

  it('should call callback on file changes', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);

    // Initialize provider by loading prompts
    await provider.getAllPrompts();

    const events: any[] = [];
    const cleanup = provider.watch!((event) => {
      events.push(event);
    });

    // Wait a bit for watcher to initialize
    await new Promise(resolve => setTimeout(resolve, 100));

    // Modify file
    await fs.writeFile(filePath, `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Changed'
  };
}
`);

    // Wait for event
    await new Promise(resolve => setTimeout(resolve, 500));

    cleanup();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('change');
  });

  it('should cleanup watcher when cleanup function is called', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);

    await provider.getAllPrompts();

    const callback = vi.fn();
    const cleanup = provider.watch!(callback);

    await new Promise(resolve => setTimeout(resolve, 100));

    cleanup();

    // Modify file after cleanup
    await fs.writeFile(filePath, `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Changed after cleanup'
  };
}
`);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Callback should not be called after cleanup
    expect(callback).not.toHaveBeenCalled();
  });

  it('should suppress watcher events for provider-originated updates', async () => {
    const fileProvider = new MemoryFileProvider({
      '/virtual/test.prompt.ts': `
export function myPrompt() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`,
    });
    const watchedProvider = new FilePromptProvider({
      rootDir: '/virtual',
      fileProvider,
    });

    await watchedProvider.getAllPrompts();

    const callback = vi.fn();
    const cleanup = watchedProvider.watch!(callback);

    await watchedProvider.updatePromptProperties('/virtual/test.prompt.ts#myPrompt', {
      system: 'Updated locally',
    });

    cleanup();

    expect(callback).not.toHaveBeenCalled();
  });

  describe('file scanning', () => {
    it('should find .prompt.ts files recursively', async () => {
      await fs.mkdir(path.join(tempDir, 'subdir'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'test.prompt.ts'), `
export function testPrompt() {
  return { model: 'openai/gpt-4o', system: 'Test' };
}
`);
      await fs.writeFile(path.join(tempDir, 'subdir', 'nested.prompt.ts'), `
export function nestedPrompt() {
  return { model: 'openai/gpt-4o', system: 'Nested' };
}
`);

      const prompts = await provider.getAllPrompts();
      expect(prompts).toHaveLength(2);
      expect(prompts.some(p => p.name === 'testPrompt')).toBe(true);
      expect(prompts.some(p => p.name === 'nestedPrompt')).toBe(true);
    });

    it('should find .promp.ts files (typo pattern)', async () => {
      await fs.writeFile(path.join(tempDir, 'typo.promp.ts'), `
export function typoPrompt() {
  return { model: 'openai/gpt-4o', system: 'Typo' };
}
`);

      const prompts = await provider.getAllPrompts();
      expect(prompts.some(p => p.name === 'typoPrompt')).toBe(true);
    });

    it('should ignore node_modules directory', async () => {
      await fs.mkdir(path.join(tempDir, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'node_modules', 'test.prompt.ts'), `
export function ignored() { return { model: 'openai/gpt-4o', system: 'Ignored' }; }
`);
      await fs.writeFile(path.join(tempDir, 'valid.prompt.ts'), `
export function valid() { return { model: 'openai/gpt-4o', system: 'Valid' }; }
`);

      const prompts = await provider.getAllPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('valid');
    });

    it('should use custom includePatterns and ignorePatterns', async () => {
      const customProvider = new FilePromptProvider({
        rootDir: tempDir,
        includePatterns: ['**/*.custom.ts'],
        ignorePatterns: [],
      });

      await fs.writeFile(path.join(tempDir, 'test.custom.ts'), `
export function customPrompt() {
  return { model: 'openai/gpt-4o', system: 'Custom' };
}
`);
      await fs.writeFile(path.join(tempDir, 'test.prompt.ts'), `
export function regularPrompt() {
  return { model: 'openai/gpt-4o', system: 'Regular' };
}
`);

      const prompts = await customProvider.getAllPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('customPrompt');
    });
  });
});
