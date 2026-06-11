// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from 'fs';
import path from 'path';

import type { PropDefinition, PropValue } from 'ts-proppy';
import type {
  ModelCatalog,
  ModelPropValue,
  ParsedPrompt,
  NormalizedPrompt,
  NormalizedPromptUpdates,
} from '../shared/types.ts';

/**
 * Adapter that provides values and execution for a particular AI SDK.
 *
 * Pass an instance of this to {@link FilePromptProvider} via the
 * `sdk` option.
 */
export interface SDKAdapter {
  /**
   * The package that exports the `prompts()` helper used in new prompt files
   * (e.g. `'@evalution/vercel-ai-sdk'`). Used by {@link PromptFileType.newPromptSkeleton}.
   */
  promptsHelperImport: string;

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

  /**
   * Convert a low-level {@link ParsedPrompt} produced by a
   * {@link PromptFileType} into a {@link NormalizedPrompt} that the UI can
   * consume without knowing the SDK's specific property names or message shape.
   *
   * @param prompt - The raw parsed prompt.
   */
  normalizePrompt(prompt: ParsedPrompt): NormalizedPrompt;

  /**
   * Convert {@link NormalizedPromptUpdates} (what the UI sends back) into the
   * raw property-name-keyed updates that {@link PromptFileType.updateProperty}
   * and friends operate on.
   *
   * @param updates - Updates expressed in the normalized vocabulary.
   * @returns A `Record` keyed by the SDK's actual property names. Values may
   *   be `null` (to remove) or a `PropValue`.
   */
  denormalizeUpdates(updates: NormalizedPromptUpdates, currentValues?: Record<string, PropValue>): Record<string, ModelPropValue | null>;
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