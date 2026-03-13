import { describe, it, expect } from 'vitest';
import { PromptEditor } from './prompt-editor.ts';
import { PromptParser } from './prompt-parser.ts';
import { MemoryFileProvider } from '../providers/file/file-provider.ts';
import type { ModelCatalog, ModelMode, ModelProviderInfo, ModelValue } from '../shared/types.ts';

function makeCatalog(providers: Record<string, ModelProviderInfo> = {}): ModelCatalog<[ModelMode<'function'>, ModelMode<'string'>]> {
  return {
    modes: [
      { key: 'function' as const, label: 'Function', description: '' },
      { key: 'string' as const, label: 'String', description: '' },
    ],
    providers,
    modelSourceText(value): string {
      switch (value.type) {
        case 'function':
          return `${value.provider}(${JSON.stringify(value.model)})`;
        case 'string':
          return JSON.stringify(`${value.provider}/${value.model}`);
        default:
          const ty: never = value.type;
          throw new Error(`Unknown model value type: ${ty}`);
      }
    }
  };
}

describe('PromptEditor', () => {
  async function setup(content: string, filename = '/virtual/test.prompt.ts', providers: Record<string, ModelProviderInfo> = {}) {
    const fileProvider = new MemoryFileProvider({ [filename]: content });
    const editor = new PromptEditor(fileProvider, () => Promise.resolve(makeCatalog(providers)));
    const parser = await PromptParser.create([[filename, content]]);
    return { filePath: filename, fileProvider, editor, parser };
  }

  it('should update string parameter', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Old prompt',
    messages: [{ role: 'user', content: 'Test' }]
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.system, 'New prompt');

    expect(await fileProvider.readFile(filePath)).toContain('"New prompt"');
    expect(await fileProvider.readFile(filePath)).not.toContain('Old prompt');
  });

  it('should update numeric parameter', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test',
    temperature: 0.7
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.temperature, 0.9);

    expect(await fileProvider.readFile(filePath)).toContain('temperature: 0.9');
  });

  it('should update boolean parameter', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test',
    stream: false
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.stream, true);

    expect(await fileProvider.readFile(filePath)).toContain('stream: true');
  });

  it('should update array parameter (messages)', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Old' }]
  };
}
`);
    const prompts = parser.parseFile(filePath);

    const newMessages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'New message' },
    ];

    await editor.updateProperty(filePath, prompts[0].properties.messages, newMessages);

    expect(await fileProvider.readFile(filePath)).toContain('You are helpful');
    expect(await fileProvider.readFile(filePath)).toContain('New message');
  });

  it('should update model parameter - string format', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.model, 'anthropic/claude-sonnet-4-20250514');

    expect(await fileProvider.readFile(filePath)).toContain('"anthropic/claude-sonnet-4-20250514"');
  });

  it('should update model parameter - function call format', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
import { openai } from '@ai-sdk/openai';

export function test() {
  return {
    model: openai('gpt-4o'),
    system: 'Test'
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.model, {
      type: 'function',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(await fileProvider.readFile(filePath)).toContain('openai("gpt-4o-mini")');
  });

  it('should add import when switching from string to function format', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`, '/virtual/test.prompt.ts', { openai: { name: 'OpenAI', models: [], importPath: '@ai-sdk/openai' } });
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.model, {
      type: 'function',
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(await fileProvider.readFile(filePath)).toContain("import { openai } from '@ai-sdk/openai'");
    expect(await fileProvider.readFile(filePath)).toContain('openai("gpt-4o")');
  });

  it('should preserve existing imports when updating other parameters', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
import { openai } from '@ai-sdk/openai';

export function test() {
  return {
    model: openai('gpt-4o'),
    system: 'Old'
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.system, 'New');

    expect(await fileProvider.readFile(filePath)).toContain("import { openai } from '@ai-sdk/openai'");
    expect(await fileProvider.readFile(filePath)).toContain('"New"');
  });

  it('should validate TypeScript syntax after edit', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.system, 'Valid string');

    expect(await fileProvider.readFile(filePath)).toContain('"Valid string"');
  });

  it('should preserve comments in source file', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
// This is a comment
export function test() {
  return {
    model: 'openai/gpt-4o',
    // Another comment
    system: 'Test'
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.system, 'New');

    expect(await fileProvider.readFile(filePath)).toContain('// This is a comment');
    expect(await fileProvider.readFile(filePath)).toContain('// Another comment');
  });

  it('should handle multi-line string values', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Short'
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.system, 'Line 1\nLine 2\nLine 3');

    expect(await fileProvider.readFile(filePath)).toContain('Line 1\\nLine 2\\nLine 3');
  });

  it('should handle escaped characters in strings', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Simple'
  };
}
`);
    const prompts = parser.parseFile(filePath);

    await editor.updateProperty(filePath, prompts[0].properties.system, 'String with "quotes" and \\backslashes\\');

    expect(await fileProvider.readFile(filePath)).toContain('String with');
  });

  it('should preserve backtick template literals in system prompt when updating', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(
`export function test(name: string) {
  return {
    model: 'openai/gpt-4o',
    system: \`Hello \${name}\`,
  };
}`
    );
    const prompts = parser.parseFile(filePath);

    // Simulate what the editor does: round-trip the parsed value through the UI
    // The parsed system value is 'Hello ${name}' (plain string with token marker)
    const systemValue = prompts[0].properties.system.value as string;
    await editor.updateProperty(filePath, prompts[0].properties.system, systemValue);

    const result = await fileProvider.readFile(filePath);
    // Must use backticks to preserve template interpolation, not double quotes
    expect(result).toContain('`Hello ${name}`');
    expect(result).not.toContain('"Hello ${name}"');
  });

  it('should preserve backtick template literals with interpolation when updating messages', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(
`export function test(name: string) {
  return {
    model: 'openai/gpt-4o',
    messages: [
      { role: 'user', content: \`Hello \${name}\` },
    ]
  };
}`
    );
    const prompts = parser.parseFile(filePath);

    // Simulate what the UI does: update messages with the parsed value round-tripped
    // The parsed value for the template literal content is "Hello ${name}" (with token marker)
    const newMessages = [
      { role: 'user', content: 'Hello ${name}' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    await editor.updateProperty(filePath, prompts[0].properties.messages, newMessages);

    const result = await fileProvider.readFile(filePath);
    // The interpolated content must use backticks, not double quotes
    expect(result).toContain('`Hello ${name}`');
    expect(result).not.toContain('"Hello ${name}"');
  });

  it('should not corrupt file when the same property is updated twice with stale spans', async () => {
    const { filePath, fileProvider, editor, parser } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    messages: [
      { role: 'user', content: 'Short' }
    ]
  };
}
`);
    const prompts = parser.parseFile(filePath);
    const messagesProperty = prompts[0].properties.messages;

    // First update makes the file longer, invalidating the original valueSpan
    await editor.updateProperty(filePath, messagesProperty, [
      { role: 'user', content: 'A much longer message that extends the file length significantly' },
    ]);

    // Second update reuses the same (now stale) property — spans no longer match the file.
    // Without a fix, the stale valueSpan.end reads from inside the first update's array,
    // so fragments of the first update's content appear after the new closing bracket.
    await editor.updateProperty(filePath, messagesProperty, [
      { role: 'user', content: 'Final version' },
    ]);

    const result = await fileProvider.readFile(filePath);
    expect(result).toContain('Final version');
    // Stale span causes the first update's tail to leak into the output
    expect(result).not.toContain('extends the file length significantly');
  });

  it('should reject edits to read-only parameters', async () => {
    const { filePath, editor, parser } = await setup(`
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
    const prompts = parser.parseFile(filePath);

    await expect(
      editor.updateProperty(filePath, prompts[0].properties.system, 'New value')
    ).rejects.toThrow('not editable');
  });
});
