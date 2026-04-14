import fs from 'fs';
import ts from 'typescript';
import { GoogleGenAI } from '@google/genai';

import type { PropDefinition, PropValue } from 'ts-proppy';
import { findTypeDeclaration, extractPropertiesFromDeclaration, valueToSourceText } from 'ts-proppy';
import { findPackageDts, stringToPropValue, type SDKAdapter } from './sdk-adapter.ts';
import { isEditable } from '../shared/helpers.ts';
import type {
  ParsedPrompt,
  NormalizedPrompt,
  NormalizedMessage,
  NormalizedParameter,
  NormalizedPromptUpdates,
} from '../shared/types.ts';

type BaseCreateInteractionParams = Parameters<typeof GoogleGenAI.prototype.interactions.create>[0];

const MODEL_KEY = 'model';
const AGENT_KEY = 'agent';
const SYSTEM_KEY = 'system_instruction';
const INPUT_KEY = 'input';
const GENERATION_CONFIG_KEY = 'generation_config';

// Fallback parameter definitions for GenerationConfig from @google/genai@1.50.0
// (GenerationConfig_2 in dist/genai.d.ts — the Interactions-API variant).
// Used when the package's .d.ts cannot be found or parsed at runtime.
const FALLBACK_GENERATION_CONFIG_PARAMS: PropDefinition[] = [
  {
    name: 'temperature',
    description: 'Controls the randomness of the output.',
    type: { kind: 'primitive', syntax: 'number' },
    optional: true,
  },
  {
    name: 'top_p',
    description: 'The maximum cumulative probability of tokens to consider when sampling.',
    type: { kind: 'primitive', syntax: 'number' },
    optional: true,
  },
  {
    name: 'max_output_tokens',
    description: 'The maximum number of tokens to include in the response.',
    type: { kind: 'primitive', syntax: 'number' },
    optional: true,
  },
  {
    name: 'seed',
    description: 'Seed used in decoding for reproducibility.',
    type: { kind: 'primitive', syntax: 'number' },
    optional: true,
  },
  {
    name: 'stop_sequences',
    description: 'A list of character sequences that will stop output interaction.',
    type: { kind: 'array', syntax: 'string[]', elementType: { kind: 'primitive', syntax: 'string' } },
    optional: true,
  },
  {
    name: 'thinking_level',
    description: 'The level of thought tokens that the model should generate.',
    type: {
      kind: 'union',
      syntax: "'minimal' | 'low' | 'medium' | 'high'",
      types: [
        { kind: 'constant', syntax: "'minimal'", value: 'minimal' },
        { kind: 'constant', syntax: "'low'", value: 'low' },
        { kind: 'constant', syntax: "'medium'", value: 'medium' },
        { kind: 'constant', syntax: "'high'", value: 'high' },
      ],
    },
    optional: true,
  },
  {
    name: 'thinking_summaries',
    description: 'Whether to include thought summaries in the response.',
    type: {
      kind: 'union',
      syntax: "'auto' | 'none'",
      types: [
        { kind: 'constant', syntax: "'auto'", value: 'auto' },
        { kind: 'constant', syntax: "'none'", value: 'none' },
      ],
    },
    optional: true,
  },
];

/**
 * {@link SDKAdapter} implementation for the Google GenAI
 * [Interactions API](https://ai.google.dev/gemini-api/docs/interactions)
 * (`@google/genai` package).
 */
export class GeminiInteractionsSDK implements SDKAdapter {
  getModelCatalog() {
    return Promise.resolve({
      modelValueTypes: {
        "model": { label: 'Models', description: 'Models' },
        "agent": { label: 'Agents', description: 'Agents' },
      },
      groups: {
        'Google': {
          customValueTemplates: {
            model: { kind: 'object', properties: { key: { kind: 'primitive', value: 'model' }, value: { kind: 'primitive', value: '$input' } } },
            agent: { kind: 'object', properties: { key: { kind: 'primitive', value: 'agent' }, value: { kind: 'primitive', value: '$input' } } },
          },
        },
      },
      models: [
        {
          id: 'gemini-3.1-flash-lite-preview',
          label: 'Gemini 3.1 Flash-Lite Preview',
          values: { model: { kind: 'object', properties: { key: { kind: 'primitive', value: 'model' }, value: { kind: 'primitive', value: 'gemini-3.1-flash-lite-preview' } } } },
          group: 'Google',
        },
        {
          id: 'gemini-3.1-pro-preview',
          label: 'Gemini 3.1 Pro Preview',
          values: { model: { kind: 'object', properties: { key: { kind: 'primitive', value: 'model' }, value: { kind: 'primitive', value: 'gemini-3.1-pro-preview' } } } },
          group: 'Google',
        },
        {
          id: 'gemini-3-flash-preview',
          label: 'Gemini 3 Flash Preview',
          values: { model: { kind: 'object', properties: { key: { kind: 'primitive', value: 'model' }, value: { kind: 'primitive', value: 'gemini-3-flash-preview' } } } },
          group: 'Google',
        },
        {
          id: 'gemini-2.5-pro',
          label: 'Gemini 2.5 Pro',
          values: { model: { kind: 'object', properties: { key: { kind: 'primitive', value: 'model' }, value: { kind: 'primitive', value: 'gemini-2.5-pro' } } } },
          group: 'Google',
        },
        {
          id: 'gemini-2.5-flash',
          label: 'Gemini 2.5 Flash',
          values: { model: { kind: 'object', properties: { key: { kind: 'primitive', value: 'model' }, value: { kind: 'primitive', value: 'gemini-2.5-flash' } } } },
          group: 'Google',
        },
        {
          id: 'gemini-2.5-flash-lite',
          label: 'Gemini 2.5 Flash-lite',
          values: { model: { kind: 'object', properties: { key: { kind: 'primitive', value: 'model' }, value: { kind: 'primitive', value: 'gemini-2.5-flash-lite' } } } },
          group: 'Google',
        },
        {
          id: 'deep-research-pro-preview-12-2025',
          label: 'Deep Research Preview',
          values: { agent: { kind: 'object', properties: { key: { kind: 'primitive', value: 'agent' }, value: { kind: 'primitive', value: 'deep-research-pro-preview-12-2025' } } } },
          group: 'Google',
        }
      ],
    } as const);
  }

  getModelParameters(rootDir: string): PropDefinition[] {
    const dtsPath = findPackageDts('@google/genai', 'dist/genai.d.ts', rootDir);
    if (dtsPath) {
      try {
        const sourceText = fs.readFileSync(dtsPath, 'utf-8');
        const sourceFile = ts.createSourceFile(dtsPath, sourceText, ts.ScriptTarget.Latest, true);
        const decl = findTypeDeclaration(sourceFile, 'GenerationConfig_2');
        if (decl) return extractPropertiesFromDeclaration(decl, sourceFile);
      } catch {
        // fall through to hardcoded defaults
      }
    }
    return FALLBACK_GENERATION_CONFIG_PARAMS;
  }

  async executeConfig(config: BaseCreateInteractionParams, stream: boolean): Promise<any> {
    const client = new GoogleGenAI({});
    const result = await client.interactions.create({ ...config, stream, store: false });

    if ('id' in result) {
      const outputs = result.outputs ?? [];
      const textOutput = outputs.find(o => o.type === 'text');
      const text = textOutput?.text ?? '';
      return { text, usage: result.usage };
    } else {
      return streamTextFromSSE(result);
    }
  }

  normalizePrompt(prompt: ParsedPrompt): NormalizedPrompt {
    const { definitions, values } = prompt.extractedProps;
    const systemValue = values?.[SYSTEM_KEY];
    const inputValue = values?.[INPUT_KEY];
    const modelValue = values?.[MODEL_KEY];
    const agentValue = values?.[AGENT_KEY];

    let model: PropValue | undefined;
    let modelEditable = false;
    if (modelValue) {
      model = {
        kind: 'object',
        properties: { key: { kind: 'primitive', value: 'model' }, value: modelValue },
        displayValue: valueToSourceText(modelValue),
      };
      modelEditable = isEditable(modelValue);
    } else if (agentValue) {
      model = {
        kind: 'object',
        properties: { key: { kind: 'primitive', value: 'agent' }, value: agentValue },
        displayValue: valueToSourceText(agentValue),
      };
      modelEditable = isEditable(agentValue);
    }

    const genConfigDef = definitions.find(d => d.name === GENERATION_CONFIG_KEY);
    const genConfigValue = values?.[GENERATION_CONFIG_KEY];
    const genConfigProps = genConfigValue?.kind === 'object' ? genConfigValue.properties : {};
    const genConfigSubDefs: PropDefinition[] = genConfigDef?.type.kind === 'object'
      ? genConfigDef.type.properties
      : [];

    const modelParameters: NormalizedParameter[] = genConfigSubDefs.map(def => {
      const value = genConfigProps[def.name];
      return { def, value, editable: value ? isEditable(value) : true };
    });

    return {
      id: prompt.id,
      providerId: prompt.providerId,
      name: prompt.name,
      functionParameters: prompt.functionParameters,
      metadata: prompt.metadata,
      treePath: prompt.treePath,
      model,
      modelEditable,
      system: systemValue,
      systemEditable: systemValue ? isEditable(systemValue) : true,
      messages: extractMessages(inputValue),
      messagesEditable: inputValue ? isEditable(inputValue) : true,
      modelParameters,
    };
  }

  denormalizeUpdates(updates: NormalizedPromptUpdates, currentValues?: Record<string, PropValue>): Record<string, PropValue | null> {
    const out: Record<string, PropValue | null> = {};
    if ('model' in updates) {
      // Only null-out keys that actually exist in the file to avoid
      // "Property not found" errors from updatePromptProperties
      if (currentValues && MODEL_KEY in currentValues) out[MODEL_KEY] = null;
      if (currentValues && AGENT_KEY in currentValues) out[AGENT_KEY] = null;

      const modelUpdate = updates.model;
      if (modelUpdate?.kind === 'object' && modelUpdate.properties.key?.kind === 'primitive') {
        const key = String(modelUpdate.properties.key.value);
        const value = modelUpdate.properties.value;
        out[key] = value;
      }
    }
    if ('system' in updates) out[SYSTEM_KEY] = updates.system ?? null;
    if ('messages' in updates) {
      out[INPUT_KEY] = updates.messages == null
        ? null
        : messagesToValue(updates.messages);
    }
    if (updates.modelParameters) {
      const current = currentValues?.[GENERATION_CONFIG_KEY];
      const merged: Record<string, PropValue> = current?.kind === 'object'
        ? { ...current.properties }
        : {};
      for (const [name, value] of Object.entries(updates.modelParameters)) {
        if (value === null) delete merged[name];
        else merged[name] = value;
      }
      out[GENERATION_CONFIG_KEY] = Object.keys(merged).length > 0
        ? { kind: 'object', properties: merged }
        : null;
    }
    return out;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a {@link NormalizedMessage} array into a PropValue representing the
 * `input` property (an array of `Turn` objects with `{role, content}`).
 *
 * The Interactions API uses `"model"` for assistant messages, so we translate
 * `"assistant"` → `"model"` on the way out.
 */
function messagesToValue(msgs: NormalizedMessage[]): PropValue {
  return {
    kind: 'array',
    elements: msgs.map(msg => ({
      kind: 'object',
      properties: {
        role: { kind: 'primitive', value: msg.role === 'assistant' ? 'model' : msg.role },
        content: stringToPropValue(msg.content),
      },
    })),
  };
}

/**
 * Extract a {@link NormalizedMessage} array from the `input` PropValue.
 *
 * The `input` field can be:
 * - A primitive string (single user message)
 * - An array of Turn objects (`{role, content}`)
 * - An array of Content objects (`{type: 'text', text: '...'}`)
 *
 * The Interactions API uses `"model"` for assistant messages; we translate
 * `"model"` → `"assistant"` on the way in.
 */
function extractMessages(value: PropValue | undefined): NormalizedMessage[] {
  if (!value) return [];

  // Plain string → single user message
  if (value.kind === 'primitive' && typeof value.value === 'string') {
    return [{ role: 'user', content: value.value }];
  }
  if (value.kind === 'template') {
    return [{ role: 'user', content: value.value }];
  }

  if (value.kind !== 'array') return [];

  return value.elements.map(el => {
    // Content object: {type: 'text', text: '...'}
    if (el.kind === 'object' && el.properties.type) {
      const text = el.properties.text;
      const content = text?.kind === 'primitive' ? String(text.value)
        : text?.kind === 'template' ? text.value : '';
      return { role: 'user', content };
    }

    // Turn object: {role, content}
    if (el.kind === 'object') {
      const roleValue = el.properties.role;
      let role = roleValue?.kind === 'primitive' ? String(roleValue.value) : 'user';
      if (role === 'model') role = 'assistant';
      const contentValue = el.properties.content;
      const content = contentValue?.kind === 'primitive' ? String(contentValue.value)
        : contentValue?.kind === 'template' ? contentValue.value : '';
      return { role, content };
    }

    return { role: 'user', content: '' };
  });
}

/**
 * Yields text chunks from the Interactions API SSE stream.
 */
async function* streamTextFromSSE(stream: AsyncIterable<any>): AsyncIterable<string> {
  for await (const chunk of stream) {
    if (chunk.event_type === 'content.delta') {
      if (chunk.delta?.type === 'text' && chunk.delta.text) {
        yield chunk.delta.text;
      }
    }
  }
}
