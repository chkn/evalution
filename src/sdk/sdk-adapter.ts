// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs";
import path from "node:path";

import type { PropDefinition, PropValue } from "ts-proppy";
import type {
  ModelCatalog,
  ModelPropValue,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  ParsedPrompt,
} from "../shared/types.ts";
import type { PromptSpanInfo } from "../trace/prompt-tracer.ts";
import type { TraceIngestor } from "../trace/trace-ingestor.ts";

/** Options for {@link SDKAdapter.executeConfig}. */
export interface ExecuteConfigOptions {
  /** The ID to use for the trace created by this execution, if any. */
  traceId?: string;
  /**
   * The prompt's identity (id, name, parameters). Used to name and link the
   * trace when the config wasn't built by the `prompts()` helper (which would
   * otherwise carry that identity itself).
   */
  identity?: PromptSpanInfo;
}

/**
 * Adapter that provides values and execution for a particular AI SDK.
 *
 * Pass an instance of this to {@link FilePromptProvider} via the
 * `sdk` option.
 *
 * Each `SDKAdapter` implementation should be paired with a companion package
 * (named by {@link SDKAdapter.promptsHelperImport}) that exports a `prompts`
 * function satisfying the {@link PromptsHelper} type. That function is the user-facing entry
 * point for defining prompts that work with Evalution. It accepts a {@link PromptsHelperOptions}
 * and a factory that can optionally receive SDK-specific parameters. The factory should return a
 * record of prompt functions. Prompt functions should return a configuration that enables OpenTelemetry
 * reporting, if possible, with the attributes returned by {@link getPromptSpanAttributes}.
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
   * Executes a prompt config object.
   *
   * @param config - The config object returned by the prompt function.
   * @param options - Optional execution options (trace id, prompt identity).
   */
  executeConfig(config: any, options?: ExecuteConfigOptions): Promise<void>;

  /**
   * Performs whatever process-global setup this SDK's tracing mechanism
   * needs (e.g. registering a native telemetry integration, or standing up an
   * OpenTelemetry pipeline) and returns the resulting {@link TraceIngestor}.
   *
   * Called once during server startup, before any prompt config is built, so
   * registration is guaranteed to happen before the first call.
   *
   * Optional — adapters with no tracing support may omit it.
   *
   * @returns The ingestor to feed into the default trace provider, or
   *   `undefined` if this SDK has no tracing support.
   */
  setupTraceIngestion?(): Promise<TraceIngestor | undefined>;

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
  denormalizeUpdates(
    updates: NormalizedPromptUpdates,
    currentValues?: Record<string, PropValue>,
  ): Record<string, ModelPropValue | null>;
}

// ─── Generic helpers ──────────────────────────────────────────────────────────

/**
 * Walk up the directory tree from both `rootDir` and `process.cwd()` looking
 * for `node_modules/<packageName>/<dtsRelPath>`.
 */
export function findPackageDts(
  packageName: string,
  dtsRelPath: string,
  rootDir: string,
): string | null {
  const seen = new Set<string>();
  for (const start of [rootDir, process.cwd()]) {
    let dir = start;
    while (!seen.has(dir)) {
      seen.add(dir);
      const candidate = path.join(dir, "node_modules", packageName, dtsRelPath);
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
