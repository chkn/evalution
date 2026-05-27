import fs from 'fs';
import ts from 'typescript';
import { generateText, streamText } from 'ai';

import type { PropDefinition, PropValue } from 'ts-proppy';
import { findTypeDeclaration, extractPropertiesFromDeclaration } from 'ts-proppy';
import { findPackageDts, stringToPropValue, type SDKAdapter } from './sdk-adapter.ts';
import { isEditable } from '../shared/helpers.ts';
import type {
  ParsedPrompt,
  NormalizedPrompt,
  NormalizedMessage,
  NormalizedParameter,
  NormalizedPromptUpdates,
  NormalizedToolCall,
  ModelInfo,
  ModelPropValue,
  CalleeBinding,
} from '../shared/types.ts';

const MODEL_KEY = 'model';
const SYSTEM_KEY = 'system';
const MESSAGES_KEY = 'messages';
const RESERVED_KEYS = new Set([MODEL_KEY, SYSTEM_KEY, MESSAGES_KEY]);

/** The `prompts()` factory from `@evalution/vercel-ai-sdk`. */
const PROMPTS_HELPER_CALL = {
  callee: 'prompts',
  import: { name: 'prompts', from: '@evalution/vercel-ai-sdk' },
} as const;

/** Build the binding-candidate array for a provider function call. */
function providerBinding(provider: string): CalleeBinding[] {
  return [
    { kind: 'parameter', enclosingCall: PROMPTS_HELPER_CALL },
    { kind: 'import', spec: { name: provider, from: `@ai-sdk/${provider}` } },
  ];
}

/** Build a {@link ModelInfo} entry from group, label, provider, and model ID. */
function model(group: string, label: string, provider: string, modelId: string): ModelInfo {
  const id = `${provider}/${modelId}`;
  return {
    id,
    label,
    group,
    values: {
      function: {
        kind: 'functionCall',
        callee: provider,
        args: [{ kind: 'primitive', value: modelId }],
        binding: providerBinding(provider),
      },
      string: { kind: 'primitive', value: id },
    },
  };
}

/** Build a custom-value template entry for a provider (used in `groups.{provider}.customValueTemplates.function`). */
function customValueTemplate(provider: string): ModelPropValue {
  return {
    kind: 'functionCall',
    callee: provider,
    args: [{ kind: 'primitive', value: '$input' }],
    binding: providerBinding(provider),
  };
}

/**
 * {@link SDKAdapter} implementation for the
 * [Vercel AI SDK](https://sdk.vercel.ai/).
 *
 * - `getModelParameters` reads `CallSettings` from the SDK's `.d.ts` bundle
 *   and surfaces parameters with simple types that can be edited in the UI.
 * - `executeConfig` delegates to `generateText` or `streamText`.
 */
export class VercelAISDK implements SDKAdapter {
  getModelCatalog() {
    // FIXME: Can we read this from the SDK instead of hardcoding it?
    return Promise.resolve({
      modelValueTypes: {
        function: { label: 'Provider', description: 'Call provider function (e.g. openai("gpt-4o"))' },
        string: { label: 'Gateway', description: 'Use a gateway model string (e.g. "openai/gpt-4o")' },
      },
      groups: {
        OpenAI: { customValueTemplates: { function: customValueTemplate('openai') } },
        Anthropic: { customValueTemplates: { function: customValueTemplate('anthropic') } },
      },
      models: [
        model('OpenAI',    'GPT-4o',           'openai',    'gpt-4o'),
        model('Anthropic', 'Claude Opus 4.7',  'anthropic', 'claude-opus-4-7'),
        model('Anthropic', 'Claude Sonnet 4.6','anthropic', 'claude-sonnet-4-6'),
        model('Anthropic', 'Claude Haiku 4.5', 'anthropic', 'claude-haiku-4-5'),
      ],
    });
  }

  getModelParameters(rootDir: string): PropDefinition[] {
    const dtsPath = findPackageDts('ai', 'dist/index.d.ts', rootDir);
    if (!dtsPath) return [];

    const sourceText = fs.readFileSync(dtsPath, 'utf-8');
    const sourceFile = ts.createSourceFile(dtsPath, sourceText, ts.ScriptTarget.Latest, true);
    const decl = findTypeDeclaration(sourceFile, 'CallSettings');
    if (!decl) return [];

    return extractPropertiesFromDeclaration(decl, sourceFile).definitions;
  }

  async executeConfig(config: any, stream: boolean): Promise<any> {
    if (stream) {
      const result = await streamText(config);
      return result.textStream;
    } else {
      const result = await generateText(config);
      return { text: result.text, usage: result.usage, finishReason: result.finishReason };
    }
  }

  normalizePrompt(prompt: ParsedPrompt): NormalizedPrompt {
    const { definitions, values } = prompt.extractedProps;
    const modelValue = values?.[MODEL_KEY];
    const systemValue = values?.[SYSTEM_KEY];
    const messagesValue = values?.[MESSAGES_KEY];

    const modelParameters: NormalizedParameter[] = definitions
      .filter(d => !RESERVED_KEYS.has(d.name))
      .map(def => {
        const value = values?.[def.name];
        return {
          def,
          value,
          editable: value ? isEditable(value) : true,
        };
      });

    return {
      id: prompt.id,
      providerId: prompt.providerId,
      name: prompt.name,
      functionParameters: prompt.functionParameters,
      metadata: prompt.metadata,
      treePath: prompt.treePath,
      model: modelValue,
      modelEditable: modelValue ? isEditable(modelValue) : true,
      system: systemValue,
      systemEditable: systemValue ? isEditable(systemValue) : true,
      messages: extractMessages(messagesValue),
      messagesEditable: messagesValue ? isEditable(messagesValue) : true,
      modelParameters,
    };
  }

  denormalizeUpdates(updates: NormalizedPromptUpdates, _currentValues?: Record<string, PropValue>): Record<string, ModelPropValue | null> {
    const out: Record<string, ModelPropValue | null> = {};
    if (MODEL_KEY in updates) out[MODEL_KEY] = updates.model ?? null;
    if (SYSTEM_KEY in updates) out[SYSTEM_KEY] = updates.system ?? null;
    if (MESSAGES_KEY in updates) {
      out[MESSAGES_KEY] = updates.messages === null || updates.messages === undefined
        ? null
        : messagesToValue(updates.messages);
    }
    if (updates.modelParameters) {
      for (const [name, value] of Object.entries(updates.modelParameters)) {
        out[name] = value;
      }
    }
    return out;
  }
}

function messagesToValue(msgs: NormalizedMessage[]): PropValue {
  return {
    kind: 'array',
    elements: msgs.map(msg => ({
      kind: 'object',
      properties: {
        role: { kind: 'primitive', value: msg.role },
        content: stringToPropValue(msg.content),
      },
    })),
  };
}

function extractMessages(value: PropValue | undefined): NormalizedMessage[] {
  if (!value || value.kind !== 'array') return [];
  return value.elements.map(el => {
    if (el.kind !== 'object') return { role: 'user', content: '' };
    const roleValue = el.properties.role;
    const role = roleValue?.kind === 'primitive' ? String(roleValue.value) : 'user';
    const contentValue = el.properties.content;
    const content = contentValue?.kind === 'primitive'
      ? String(contentValue.value)
      : contentValue?.kind === 'template' ? contentValue.value : '';
    const toolCalls = extractToolCalls(el.properties.toolCalls);
    return toolCalls ? { role, content, toolCalls } : { role, content };
  });
}

function extractToolCalls(value: PropValue | undefined): NormalizedToolCall[] | undefined {
  if (!value || value.kind !== 'array') return undefined;
  const out: NormalizedToolCall[] = [];
  for (const el of value.elements) {
    if (el.kind !== 'object') continue;
    const name = el.properties.toolName;
    const args = el.properties.args;
    out.push({
      toolName: name?.kind === 'primitive' ? String(name.value) : '',
      args: args?.kind === 'primitive' ? String(args.value) : '',
    });
  }
  return out.length > 0 ? out : undefined;
}
