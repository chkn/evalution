import { describe, it, expect } from 'vitest';
import { PromptParser } from './prompt-parser.ts';
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
    it('should parse string literal parameters', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const system = prompts[0].properties.system;
      expect(system.value).toBe('You are a weather assistant');
      expect(system.isEditable).toBe(true);
      expect(system.hasParameterTokens).toBe(false);
    });

    it('should parse numeric parameters', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const temperature = prompts[0].properties.temperature;
      expect(temperature.value).toBe(0.7);
      expect(temperature.isEditable).toBe(true);

      const maxTokens = prompts[0].properties.maxTokens;
      expect(maxTokens.value).toBe(500);
    });

    it('should parse array parameters (messages)', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const messages = prompts[0].properties.messages;
      expect(Array.isArray(messages.value)).toBe(true);
      expect(messages.value).toHaveLength(1);
      expect(messages.value[0]).toEqual({
        role: 'user',
        content: 'What is the weather in SF?',
      });
    });
  });

  describe('parameter tokens', () => {
    it('should parse template literals with parameter tokens', async () => {
      const { paths, parser } = await loadFixtures('parameterized.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const system = prompts[0].properties.system;
      expect(system.value).toBe('You are a friendly assistant speaking in ${language}');
      expect(system.hasParameterTokens).toBe(true);
      expect(system.isEditable).toBe(true);

      const messages = prompts[0].properties.messages;
      expect(messages.value[0].content).toBe('Hello, my name is ${name}');
      expect(messages.hasParameterTokens).toBe(true);
    });

    it('should parse string concatenation with params', async () => {
      const { paths, parser } = await loadFixtures('concatenation.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const system = prompts[0].properties.system;
      expect(system.value).toBe('You are a code reviewer for ${username}');
      expect(system.hasParameterTokens).toBe(true);

      const messages = prompts[0].properties.messages;
      expect(messages.value[0].content).toBe('Review this code: ${codeSnippet}');
      expect(messages.hasParameterTokens).toBe(true);
    });

    it('should parse arithmetic expressions with params', async () => {
      const { paths, parser } = await loadFixtures('complex.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const temperature = prompts[0].properties.temperature;
      expect(temperature.value).toContain('${baseTemp}');
      expect(temperature.hasParameterTokens).toBe(true);

      const maxTokens = prompts[0].properties.maxTokens;
      expect(maxTokens.value).toContain('${multiplier}');
      expect(maxTokens.hasParameterTokens).toBe(true);
    });

    it('should set hasParameterTokens: true when params are used', async () => {
      const { paths, parser } = await loadFixtures('parameterized.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts[0].properties.system.hasParameterTokens).toBe(true);
      expect(prompts[0].properties.messages.hasParameterTokens).toBe(true);
      expect(prompts[0].properties.temperature.hasParameterTokens).toBe(false);
    });

    it('should handle object parameter with field interpolation', async () => {
      const { paths, parser } = await loadFixtures('object-param.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('userProfile');

      // Should parse object parameter
      expect(prompts[0].functionParameters).toHaveLength(1);
      expect(prompts[0].functionParameters[0].name).toBe('config');
      expect(prompts[0].functionParameters[0].type).toBe('{ name: string; age: number }');

      // Should preserve field references as tokens
      const system = prompts[0].properties.system;
      expect(system.value).toBe('User is ${config.name}, age ${config.age}');
      expect(system.hasParameterTokens).toBe(true);

      const messages = prompts[0].properties.messages;
      expect(messages.value[0].content).toBe('Tell me about ${config.name}');
      expect(messages.hasParameterTokens).toBe(true);
    });

    it('should handle destructured object parameters', async () => {
      const { paths, parser } = await loadFixtures('destructured-param.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('userGreeting');

      // Should parse destructured parameters
      expect(prompts[0].functionParameters.length).toBeGreaterThan(0);

      // Should preserve direct field references as tokens
      const system = prompts[0].properties.system;
      expect(system.value).toContain('${name}');
      expect(system.value).toContain('${age}');
      expect(system.hasParameterTokens).toBe(true);

      const messages = prompts[0].properties.messages;
      expect(messages.value[0].content).toContain('${name}');
      expect(messages.hasParameterTokens).toBe(true);
    });

    it('should handle destructured parameters with default values', async () => {
      const { paths, parser } = await loadFixtures('destructured-defaults.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('customGreeting');

      // Should parse destructured parameters with defaults
      expect(prompts[0].functionParameters).toHaveLength(2);

      const nameParam = prompts[0].functionParameters.find(p => p.name === 'name');
      expect(nameParam).toBeDefined();
      expect(nameParam!.defaultValue).toBeUndefined();

      const greetingParam = prompts[0].functionParameters.find(p => p.name === 'greeting');
      expect(greetingParam).toBeDefined();
      expect(greetingParam!.defaultValue).toBe('Hello');

      // Should preserve parameter references in values
      const system = prompts[0].properties.system;
      expect(system.value).toContain('${greeting}');
      expect(system.value).toContain('${name}');
      expect(system.hasParameterTokens).toBe(true);
    });
  });

  describe('model parameter', () => {
    it('should parse model parameter - string format', async () => {
      const { paths, parser } = await loadFixtures('basic.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const model = prompts[0].properties.model;
      expect(model.value).toBe('openai/gpt-4o');
      expect(model.isEditable).toBe(true);
      expect(model.hasParameterTokens).toBe(false);
    });

    it('should parse model parameter - function call format', async () => {
      const { paths, parser } = await loadFixtures('function-model.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const model = prompts[0].properties.model;
      expect(model.value).toEqual({
        type: 'function',
        provider: 'openai',
        model: 'gpt-4o',
      });
      expect(model.isEditable).toBe(true);
      expect(model.hasParameterTokens).toBe(false);
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

      // Literals are editable
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

      // Should still parse what it can, or return empty array
      expect(Array.isArray(prompts)).toBe(true);
    });

    it('should handle nested object structures in parameters', async () => {
      const { paths, parser } = await loadFixtures('complex.prompt.ts');
      const prompts = parser.parseFile(paths[0]);

      const messages = prompts[0].properties.messages;
      expect(Array.isArray(messages.value)).toBe(true);
      expect(messages.value.length).toBeGreaterThan(0);
      expect(messages.value[0]).toHaveProperty('role');
      expect(messages.value[0]).toHaveProperty('content');
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
