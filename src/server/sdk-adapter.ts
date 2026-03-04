import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import { generateText, streamText } from 'ai';
import type { ModelParameterInfo } from '../shared/types.ts';

/**
 * Adapter that bridges a prompt config object produced by a
 * {@link PromptFileType} with the execution layer of an AI SDK.
 *
 * Implement this interface to add support for SDKs other than the Vercel AI
 * SDK, then pass your implementation to {@link FilePromptProvider} via the
 * `sdk` option.
 */
export interface SDKAdapter {
  /**
   * Returns the list of model parameters that can be edited in the playground
   * UI for projects rooted at `rootDir`. Typically extracted from the SDK's
   * published TypeScript type definitions.
   *
   * @param rootDir - Absolute path to the project root.
   */
  getModelParameters(rootDir: string): ModelParameterInfo[];

  /**
   * Executes a prompt config object and returns either a result object (when
   * `stream` is `false`) or an async text iterable (when `stream` is `true`).
   *
   * @param config - The config object returned by the prompt function.
   * @param stream - When `true`, returns a streaming text iterator.
   */
  executeConfig(config: any, stream: boolean): Promise<any>;
}

// ─── Generic helpers ──────────────────────────────────────────────────────────

// Only surface parameters whose types can be trivially edited in the UI
const SIMPLE_TYPES = new Set(['number', 'string', 'boolean', 'string[]']);

function defaultForType(typeStr: string): any {
  if (typeStr === 'number') return 0;
  if (typeStr === 'string') return '';
  if (typeStr === 'boolean') return false;
  if (typeStr === 'string[]') return [];
  return null;
}

/**
 * Walk up the directory tree from both `rootDir` and `process.cwd()` looking
 * for `node_modules/<packageName>/<dtsRelPath>`.
 */
export function findPackageDts(packageName: string, dtsRelPath: string, rootDir: string): string | null {
  const seen = new Set<string>();
  for (const start of [rootDir, process.cwd()]) {
    let dir = start;
    while (!seen.has(dir)) {
      seen.add(dir);
      const candidate = path.join(dir, 'node_modules', packageName, dtsRelPath);
      try {
        fs.accessSync(candidate);
        return candidate;
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function extractJsDoc(fullText: string, node: ts.Node): string {
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!ranges?.length) return '';
  const last = ranges[ranges.length - 1];
  const raw = fullText.slice(last.pos, last.end);
  return raw
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .replace(/\n(?!\s*\n)/, '')
    .trim();
}

/**
 * Extract simple-type members from a named type alias in a `.d.ts` file,
 * along with their JSDoc descriptions and inferred default values.
 */
export function extractTypeMembers(dtsPath: string, typeName: string): ModelParameterInfo[] {
  const sourceText = fs.readFileSync(dtsPath, 'utf-8');
  const sourceFile = ts.createSourceFile(dtsPath, sourceText, ts.ScriptTarget.Latest, true);

  const results: ModelParameterInfo[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      if (ts.isTypeLiteralNode(node.type)) {
        for (const member of node.type.members) {
          if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
            const typeStr = member.type?.getText(sourceFile).trim() ?? 'unknown';
            if (SIMPLE_TYPES.has(typeStr)) {
              results.push({
                name: member.name.text,
                type: typeStr,
                defaultValue: defaultForType(typeStr),
                description: extractJsDoc(sourceText, member),
              });
            }
          }
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return results;
}

// ─── Vercel AI SDK implementation ─────────────────────────────────────────────

/**
 * {@link SDKAdapter} implementation for the
 * [Vercel AI SDK](https://sdk.vercel.ai/).
 *
 * - `getModelParameters` reads `CallSettings` from the SDK's `.d.ts` bundle
 *   and surfaces parameters with simple types that can be edited in the UI.
 * - `executeConfig` delegates to `generateText` or `streamText`.
 */
export class VercelAISDK implements SDKAdapter {
  getModelParameters(rootDir: string): ModelParameterInfo[] {
    const dtsPath = findPackageDts('ai', 'dist/index.d.ts', rootDir);
    if (!dtsPath) return [];
    return extractTypeMembers(dtsPath, 'CallSettings');
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
