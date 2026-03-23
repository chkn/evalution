import { describe, it, expect } from 'vitest';
import { PromptParser } from './prompt-parser.ts';
import type { PropValue } from '../shared/types.ts';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixturesDir = path.join(__dirname, '__fixtures__');

async function loadFixtures(...fileNames: string[]): Promise<{ paths: string[]; parser: PromptParser; }> {
  const paths = fileNames.map(f => path.join(fixturesDir, f));
  const contents = paths.map(p => [p, fs.readFile(p, 'utf-8')] as const);
  return { paths, parser: await PromptParser.create(contents) };
}

describe('PromptParser', () => {
  describe('basic parsing', () => {
    it('should parse file with single exported function (no parameters)', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('checkWeather');
      expect(prompts[0].functionParameters).toHaveLength(0);
      expect(prompts[0].properties.model).toBeDefined();
      expect(prompts[0].properties.system).toBeDefined();
      expect(prompts[0].properties.messages).toBeDefined();
    });

    it('should parse file with multiple exported functions', async () => {
      const { paths, parser } = await loadFixtures('multiple-exports.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts).toHaveLength(2);
      expect(prompts[0].name).toBe('promptOne');
      expect(prompts[1].name).toBe('promptTwo');
    });

    it('should extract function names as prompt names', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts[0].name).toBe('checkWeather');
      expect(prompts[0].id).toBe(`${paths[0]}#checkWeather`);
    });
  });

  describe('function parameters', () => {
    it('should parse function parameters (name, type, default value)', async () => {
      const { paths, parser } = await loadFixtures('parameterized.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts[0].functionParameters).toHaveLength(2);
      expect(prompts[0].functionParameters[0]).toEqual({
        name: 'name',
        type: 'string',
        defaultValue: undefined,
      });
      expect(prompts[0].functionParameters[1]).toEqual({
        name: 'language',
        type: undefined,
        defaultValue: 'en',
      });
    });
  });

  describe('property parsing', () => {
    it('should parse string literal parameters as PropValue', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const system = prompts[0].properties.system;
      expect(system.value).toEqual({ kind: 'primitive', value: 'You are a weather assistant' });
      expect(system.isEditable).toBe(true);
    });

    it('should parse numeric parameters as PropValue', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const temperature = prompts[0].properties.temperature;
      expect(temperature.value).toEqual({ kind: 'primitive', value: 0.7 });
      expect(temperature.isEditable).toBe(true);

      const maxTokens = prompts[0].properties.maxTokens;
      expect(maxTokens.value).toEqual({ kind: 'primitive', value: 500 });
    });

    it('should parse array parameters (messages) as PropValue', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const messages = prompts[0].properties.messages;
      const value = messages.value as PropValue;
      expect(value.kind).toBe('array');
      if (value.kind === 'array') {
        expect(value.elements).toHaveLength(1);
        expect(value.elements[0]).toEqual({
          kind: 'object',
          properties: {
            role: { kind: 'primitive', value: 'user' },
            content: { kind: 'primitive', value: 'What is the weather in SF?' },
          },
        });
      }
    });
  });

  describe('template values', () => {
    it('should parse template literals as template PropValue', async () => {
      const { paths, parser } = await loadFixtures('parameterized.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const system = prompts[0].properties.system;
      expect(system.value).toEqual({ kind: 'template', value: 'You are a friendly assistant speaking in ${language}' });
      expect(system.isEditable).toBe(true);

      const messages = prompts[0].properties.messages;
      const msgValue = messages.value as PropValue;
      expect(msgValue.kind).toBe('array');
      if (msgValue.kind === 'array') {
        const content = (msgValue.elements[0] as Extract<PropValue, { kind: 'object' }>).properties.content;
        expect(content).toEqual({ kind: 'template', value: 'Hello, my name is ${name}' });
      }
    });

    it('should handle object parameter with field interpolation', async () => {
      const { paths, parser } = await loadFixtures('object-param.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('userProfile');

      expect(prompts[0].functionParameters).toHaveLength(1);
      expect(prompts[0].functionParameters[0].name).toBe('config');
      expect(prompts[0].functionParameters[0].type).toBe('{ name: string; age: number }');

      const system = prompts[0].properties.system;
      expect(system.value).toEqual({ kind: 'template', value: 'User is ${config.name}, age ${config.age}' });

      const messages = prompts[0].properties.messages;
      const msgValue = messages.value as PropValue;
      if (msgValue.kind === 'array') {
        const content = (msgValue.elements[0] as Extract<PropValue, { kind: 'object' }>).properties.content;
        expect(content).toEqual({ kind: 'template', value: 'Tell me about ${config.name}' });
      }
    });

    it('should handle destructured object parameters', async () => {
      const { paths, parser } = await loadFixtures('destructured-param.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('userGreeting');
      expect(prompts[0].functionParameters.length).toBeGreaterThan(0);

      const system = prompts[0].properties.system;
      const sysValue = system.value as PropValue;
      expect(sysValue.kind).toBe('template');
      if (sysValue.kind === 'template') {
        expect(sysValue.value).toContain('${name}');
        expect(sysValue.value).toContain('${age}');
      }
    });

    it('should handle destructured parameters with default values', async () => {
      const { paths, parser } = await loadFixtures('destructured-defaults.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('customGreeting');
      expect(prompts[0].functionParameters).toHaveLength(2);

      const nameParam = prompts[0].functionParameters.find(p => p.name === 'name');
      expect(nameParam).toBeDefined();
      expect(nameParam!.defaultValue).toBeUndefined();

      const greetingParam = prompts[0].functionParameters.find(p => p.name === 'greeting');
      expect(greetingParam).toBeDefined();
      expect(greetingParam!.defaultValue).toBe('Hello');

      const system = prompts[0].properties.system;
      const sysValue = system.value as PropValue;
      expect(sysValue.kind).toBe('template');
      if (sysValue.kind === 'template') {
        expect(sysValue.value).toContain('${greeting}');
        expect(sysValue.value).toContain('${name}');
      }
    });
  });

  describe('model parameter', () => {
    it('should parse model parameter - string format', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const model = prompts[0].properties.model;
      expect(model.value).toEqual({ kind: 'primitive', value: 'openai/gpt-4o' });
      expect(model.isEditable).toBe(true);
    });

    it('should parse model parameter - function call format', async () => {
      const { paths, parser } = await loadFixtures('function-model.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const model = prompts[0].properties.model;
      const modelValue = model.value as PropValue;
      expect(modelValue.kind).toBe('functionCall');
      if (modelValue.kind === 'functionCall') {
        expect(modelValue.callee).toBe('openai');
        expect(modelValue.args).toEqual([{ kind: 'primitive', value: 'gpt-4o' }]);
        expect(modelValue.import).toEqual({ name: 'openai', from: '@ai-sdk/openai' });
      }
      expect(model.isEditable).toBe(true);
    });
  });

  describe('source information', () => {
    it('should extract source spans for all parameters', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const system = prompts[0].properties.system;
      expect(system.valueSpan).toBeDefined();
      expect(system.valueSpan!.start).toBeGreaterThan(0);
      expect(system.valueSpan!.end).toBeGreaterThan(system.valueSpan!.start);
      expect(system.sourceText).toBeDefined();
    });
  });

  describe('editability', () => {
    it('should identify editable vs read-only parameters', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts[0].properties.system.isEditable).toBe(true);
      expect(prompts[0].properties.temperature.isEditable).toBe(true);
    });

    it('should handle dynamic/computed values (mark as read-only)', async () => {
      const { paths, parser } = await loadFixtures('dynamic-values.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const system = prompts[0].properties.system;
      expect(system.isEditable).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle files with syntax errors gracefully', async () => {
      const { paths, parser } = await loadFixtures('invalid-syntax.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(Array.isArray(prompts)).toBe(true);
    });

    it('should handle nested object structures in parameters', async () => {
      const { paths, parser } = await loadFixtures('complex.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const messages = prompts[0].properties.messages;
      const msgValue = messages.value as PropValue;
      expect(msgValue.kind).toBe('array');
      if (msgValue.kind === 'array') {
        expect(msgValue.elements.length).toBeGreaterThan(0);
        const first = msgValue.elements[0];
        expect(first.kind).toBe('object');
        if (first.kind === 'object') {
          expect(first.properties).toHaveProperty('role');
          expect(first.properties).toHaveProperty('content');
        }
      }
    });
  });

  describe('parseAll', () => {
    it('should parse all files in the program', async () => {
      const { parser } = await loadFixtures('basic.prompt.ts', 'function-model.prompt.ts');
      const allPrompts = parser.parseAll();

      expect(allPrompts.length).toBeGreaterThanOrEqual(2);
    });
  });
});
