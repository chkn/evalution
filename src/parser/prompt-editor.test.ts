import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PromptEditor } from './prompt-editor.ts';
import { PromptParser } from './prompt-parser.ts';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('PromptEditor', () => {
  let tempDir: string;
  let editor: PromptEditor;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evalution-editor-test-'));
    editor = new PromptEditor();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should update string parameter and preserve formatting', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Old prompt',
    messages: [{ role: 'user', content: 'Test' }]
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const systemProp = prompts[0].properties.system;

    await editor.updateProperty(filePath, systemProp, 'New prompt');

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('"New prompt"');
    expect(newContent).not.toContain('Old prompt');
  });

  it('should update numeric parameter', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test',
    temperature: 0.7
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const tempProp = prompts[0].properties.temperature;

    await editor.updateProperty(filePath, tempProp, 0.9);

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('temperature: 0.9');
  });

  it('should update boolean parameter', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test',
    stream: false
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const streamProp = prompts[0].properties.stream;

    await editor.updateProperty(filePath, streamProp, true);

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('stream: true');
  });

  it('should update array parameter (messages)', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Old' }]
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const messagesProp = prompts[0].properties.messages;

    const newMessages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'New message' },
    ];

    await editor.updateProperty(filePath, messagesProp, newMessages);

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('You are helpful');
    expect(newContent).toContain('New message');
  });

  it('should update model parameter - string format', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const modelProp = prompts[0].properties.model;

    await editor.updateProperty(filePath, modelProp, 'anthropic/claude-sonnet-4-20250514');

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('"anthropic/claude-sonnet-4-20250514"');
  });

  it('should update model parameter - function call format', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
import { openai } from '@ai-sdk/openai';

export function test() {
  return {
    model: openai('gpt-4o'),
    system: 'Test'
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const modelProp = prompts[0].properties.model;

    await editor.updateProperty(filePath, modelProp, {
      type: 'function',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('openai("gpt-4o-mini")');
  });

  it('should add import when switching from string to function format', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const modelProp = prompts[0].properties.model;

    await editor.updateProperty(filePath, modelProp, {
      type: 'function',
      provider: 'openai',
      model: 'gpt-4o',
    });

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain("import { openai } from '@ai-sdk/openai'");
    expect(newContent).toContain('openai("gpt-4o")');
  });

  it('should preserve existing imports when updating other parameters', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
import { openai } from '@ai-sdk/openai';

export function test() {
  return {
    model: openai('gpt-4o'),
    system: 'Old'
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const systemProp = prompts[0].properties.system;

    await editor.updateProperty(filePath, systemProp, 'New');

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain("import { openai } from '@ai-sdk/openai'");
    expect(newContent).toContain('"New"');
  });

  it('should validate TypeScript syntax after edit', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const systemProp = prompts[0].properties.system;

    // This should work fine
    await editor.updateProperty(filePath, systemProp, 'Valid string');

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('"Valid string"');
  });

  it('should preserve comments in source file', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
// This is a comment
export function test() {
  return {
    model: 'openai/gpt-4o',
    // Another comment
    system: 'Test'
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const systemProp = prompts[0].properties.system;

    await editor.updateProperty(filePath, systemProp, 'New');

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('// This is a comment');
    expect(newContent).toContain('// Another comment');
  });

  it('should handle multi-line string values', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Short'
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const systemProp = prompts[0].properties.system;

    await editor.updateProperty(filePath, systemProp, 'Line 1\nLine 2\nLine 3');

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('Line 1\\nLine 2\\nLine 3');
  });

  it('should handle escaped characters in strings', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Simple'
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const systemProp = prompts[0].properties.system;

    await editor.updateProperty(filePath, systemProp, 'String with "quotes" and \\backslashes\\');

    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('String with');
  });

  it('should reject edits to read-only parameters', async () => {
    const filePath = path.join(tempDir, 'test.prompt.ts');
    await fs.writeFile(filePath, `
function getDynamic() {
  return 'dynamic';
}

export function test() {
  return {
    model: 'openai/gpt-4o',
    system: getDynamic()
  };
}
`);

    const parser = new PromptParser([filePath]);
    const prompts = parser.parseFile(filePath);
    const systemProp = prompts[0].properties.system;

    await expect(
      editor.updateProperty(filePath, systemProp, 'New value')
    ).rejects.toThrow('not editable');
  });
});
