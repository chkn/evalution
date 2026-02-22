import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileSystemPromptProvider } from './filesystem-provider.ts';
import { PromptEditor } from '../parser/prompt-editor.ts';
import { FileScanner } from '../cli/file-scanner.ts';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('FileSystemPromptProvider', () => {
  let tempDir: string;
  let provider: FileSystemPromptProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evalution-provider-test-'));
    const editor = new PromptEditor();
    const scanner = new FileScanner();
    provider = new FileSystemPromptProvider(tempDir, editor, scanner);
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

    const promptId = `${filePath}#myPrompt`;
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
});
