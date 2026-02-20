import { describe, it, expect } from 'vitest';
import { PromptParser } from './prompt-parser.ts';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixturesDir = path.join(__dirname, '__fixtures__');

describe('PromptParser', () => {
  describe('basic parsing', () => {
    it('should parse file with single exported function (no parameters)', () => {
      const filePath = path.join(fixturesDir, 'basic.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('checkWeather');
      expect(prompts[0].functionParameters).toHaveLength(0);
      expect(prompts[0].properties.model).toBeDefined();
      expect(prompts[0].properties.system).toBeDefined();
      expect(prompts[0].properties.messages).toBeDefined();
    });

    it('should parse file with multiple exported functions', () => {
      const filePath = path.join(fixturesDir, 'multiple-exports.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      expect(prompts).toHaveLength(2);
      expect(prompts[0].name).toBe('promptOne');
      expect(prompts[1].name).toBe('promptTwo');
    });

    it('should extract function names as prompt names', () => {
      const filePath = path.join(fixturesDir, 'basic.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      expect(prompts[0].name).toBe('checkWeather');
      expect(prompts[0].id).toBe(`${filePath}#checkWeather`);
    });
  });

  describe('function parameters', () => {
    it('should parse function parameters (name, type, default value)', () => {
      const filePath = path.join(fixturesDir, 'parameterized.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

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
    it('should parse string literal parameters', () => {
      const filePath = path.join(fixturesDir, 'basic.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const system = prompts[0].properties.system;
      expect(system.value).toBe('You are a weather assistant');
      expect(system.isEditable).toBe(true);
      expect(system.hasParameterTokens).toBe(false);
    });

    it('should parse numeric parameters', () => {
      const filePath = path.join(fixturesDir, 'basic.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const temperature = prompts[0].properties.temperature;
      expect(temperature.value).toBe(0.7);
      expect(temperature.isEditable).toBe(true);

      const maxTokens = prompts[0].properties.maxTokens;
      expect(maxTokens.value).toBe(500);
    });

    it('should parse array parameters (messages)', () => {
      const filePath = path.join(fixturesDir, 'basic.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

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
    it('should parse template literals with parameter tokens', () => {
      const filePath = path.join(fixturesDir, 'parameterized.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const system = prompts[0].properties.system;
      expect(system.value).toBe('You are a friendly assistant speaking in ${language}');
      expect(system.hasParameterTokens).toBe(true);
      expect(system.isEditable).toBe(true);

      const messages = prompts[0].properties.messages;
      expect(messages.value[0].content).toBe('Hello, my name is ${name}');
      expect(messages.hasParameterTokens).toBe(true);
    });

    it('should parse string concatenation with params', () => {
      const filePath = path.join(fixturesDir, 'concatenation.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const system = prompts[0].properties.system;
      expect(system.value).toBe('You are a code reviewer for ${username}');
      expect(system.hasParameterTokens).toBe(true);

      const messages = prompts[0].properties.messages;
      expect(messages.value[0].content).toBe('Review this code: ${codeSnippet}');
      expect(messages.hasParameterTokens).toBe(true);
    });

    it('should parse arithmetic expressions with params', () => {
      const filePath = path.join(fixturesDir, 'complex.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const temperature = prompts[0].properties.temperature;
      expect(temperature.value).toContain('${baseTemp}');
      expect(temperature.hasParameterTokens).toBe(true);

      const maxTokens = prompts[0].properties.maxTokens;
      expect(maxTokens.value).toContain('${multiplier}');
      expect(maxTokens.hasParameterTokens).toBe(true);
    });

    it('should set hasParameterTokens: true when params are used', () => {
      const filePath = path.join(fixturesDir, 'parameterized.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      expect(prompts[0].properties.system.hasParameterTokens).toBe(true);
      expect(prompts[0].properties.messages.hasParameterTokens).toBe(true);
      expect(prompts[0].properties.temperature.hasParameterTokens).toBe(false);
    });

    it('should handle object parameter with field interpolation', () => {
      const filePath = path.join(fixturesDir, 'object-param.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

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

    it('should handle destructured object parameters', () => {
      const filePath = path.join(fixturesDir, 'destructured-param.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

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

    it('should handle destructured parameters with default values', () => {
      const filePath = path.join(fixturesDir, 'destructured-defaults.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

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
    it('should parse model parameter - string format', () => {
      const filePath = path.join(fixturesDir, 'basic.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const model = prompts[0].properties.model;
      expect(model.value).toBe('openai/gpt-4o');
      expect(model.isEditable).toBe(true);
      expect(model.hasParameterTokens).toBe(false);
    });

    it('should parse model parameter - function call format', () => {
      const filePath = path.join(fixturesDir, 'function-model.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

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
    it('should extract source spans for all parameters', () => {
      const filePath = path.join(fixturesDir, 'basic.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const system = prompts[0].properties.system;
      expect(system.sourceSpan).toBeDefined();
      expect(system.sourceSpan!.start).toBeGreaterThan(0);
      expect(system.sourceSpan!.end).toBeGreaterThan(system.sourceSpan!.start);
      expect(system.sourceText).toBeDefined();
    });
  });

  describe('editability', () => {
    it('should identify editable vs read-only parameters', () => {
      const filePath = path.join(fixturesDir, 'basic.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      // Literals are editable
      expect(prompts[0].properties.system.isEditable).toBe(true);
      expect(prompts[0].properties.temperature.isEditable).toBe(true);
    });

    it('should handle dynamic/computed values (mark as read-only)', () => {
      const filePath = path.join(fixturesDir, 'dynamic-values.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const system = prompts[0].properties.system;
      expect(system.isEditable).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle files with syntax errors gracefully', () => {
      const filePath = path.join(fixturesDir, 'invalid-syntax.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      // Should still parse what it can, or return empty array
      expect(Array.isArray(prompts)).toBe(true);
    });

    it('should handle nested object structures in parameters', () => {
      const filePath = path.join(fixturesDir, 'complex.prompt.ts');
      const parser = new PromptParser([filePath]);
      const prompts = parser.parseFile(filePath);

      const messages = prompts[0].properties.messages;
      expect(Array.isArray(messages.value)).toBe(true);
      expect(messages.value.length).toBeGreaterThan(0);
      expect(messages.value[0]).toHaveProperty('role');
      expect(messages.value[0]).toHaveProperty('content');
    });
  });

  describe('parseAll', () => {
    it('should parse all files in the program', () => {
      const files = [
        path.join(fixturesDir, 'basic.prompt.ts'),
        path.join(fixturesDir, 'function-model.prompt.ts'),
      ];
      const parser = new PromptParser(files);
      const allPrompts = parser.parseAll();

      expect(allPrompts.length).toBeGreaterThanOrEqual(2);
    });
  });
});
