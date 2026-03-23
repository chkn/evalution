import fs from 'fs';
import path from 'path';

import type { PropDefinition } from 'ts-proppy';
import type { ModelCatalog } from '../shared/types.ts';

/**
 * Adapter that provides values and execution for a particular AI SDK.
 *
 * Implement this interface to add support for SDKs other than the Vercel AI
 * SDK, then pass your implementation to {@link FilePromptProvider} via the
 * `sdk` option.
 */
export interface SDKAdapter {
  /**
   * Returns model catalog information: the set of known providers and a
   * curated list of popular models for this SDK.
   */
  getModelCatalog(): Promise<ModelCatalog>;

  /**
   * Returns the list of model parameters that can be edited in the playground
   * UI for projects rooted at `rootDir`. Typically extracted from the SDK's
   * published TypeScript type definitions.
   *
   * @param rootDir - Absolute path to the project root.
   */
  getModelParameters(rootDir: string): PropDefinition[];

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
