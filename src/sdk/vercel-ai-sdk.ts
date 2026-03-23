import fs from 'fs';
import ts from 'typescript';
import { generateText, streamText } from 'ai';

import type { PropDefinition } from 'ts-proppy';
import { findTypeDeclaration, extractPropertiesFromDeclaration } from 'ts-proppy';
import { findPackageDts, type SDKAdapter } from './sdk-adapter.ts';

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
        "function": { label: 'Provider', description: 'Import and call provider SDK (e.g. openai("gpt-4o"))' },
        "string": { label: 'Gateway', description: 'Use a gateway model string (e.g. "openai/gpt-4o")' },
      },
      groups: {
        'OpenAI': {
          customValueTemplates: {
            function: { kind: 'functionCall' as const, callee: 'openai', args: [{ kind: 'primitive' as const, value: '$input' }], import: { name: 'openai', from: '@ai-sdk/openai' } },
            string: { kind: 'primitive' as const, value: 'openai/$input' },
          },
        },
      },
      models: [
        {
          id: 'openai/gpt-4o',
          label: 'GPT-4o (OpenAI)',
          values: {
            function: { kind: 'functionCall' as const, callee: 'openai', args: [{ kind: 'primitive' as const, value: 'gpt-4o' }], import: { name: 'openai', from: '@ai-sdk/openai' } },
            string: { kind: 'primitive' as const, value: 'openai/gpt-4o' },
          },
          group: 'OpenAI',
        },
      ]
    });
  }

  getModelParameters(rootDir: string): PropDefinition[] {
    const dtsPath = findPackageDts('ai', 'dist/index.d.ts', rootDir);
    if (!dtsPath) return [];

    const sourceText = fs.readFileSync(dtsPath, 'utf-8');
    const sourceFile = ts.createSourceFile(dtsPath, sourceText, ts.ScriptTarget.Latest, true);
    const decl = findTypeDeclaration(sourceFile, 'CallSettings');
    if (!decl) return [];

    return extractPropertiesFromDeclaration(decl, sourceFile);
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
}
