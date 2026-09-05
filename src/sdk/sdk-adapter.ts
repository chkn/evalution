// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs";
import path from "node:path";

import type { PropDefinition, PropValue } from "ts-proppy";
import type { TypeProbe } from "../prompt/file/prompt-file-type.ts";
import type {
  ModelCatalog,
  ModelPropValue,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  ParsedPrompt,
} from "../shared/types.ts";
import type { setupGlobalOTelPipeline } from "../trace/otel-global-pipeline.ts";
import type { PromptSpanInfo } from "../trace/prompt-tracer.ts";
import type { TraceIngestor } from "../trace/trace-ingestor.ts";
import type { TraceSink } from "../trace/trace-sink.ts";

/** Options for {@link SDKAdapter.executeConfig}. */
export interface ExecuteConfigOptions {
  /** The ID to use for the trace created by this execution, if any. */
  traceId?: string;
  /**
   * The prompt's identity (id, name, inputs). Used to name and link the
   * trace when the config wasn't built by the `prompts()` helper (which would
   * otherwise carry that identity itself).
   */
  identity?: PromptSpanInfo;
  /**
   * Named values the SDK needs to execute this config, resolved from the
   * prompt's `executeParameters` — the Vercel AI SDK's `toolsContext`, say.
   *
   * How they reach the underlying call is the adapter's business: merging
   * them generically would assume an execute parameter's name is always a
   * config key, which is true for `toolsContext` but is the adapter's fact to
   * know rather than the caller's.
   */
  executeValues?: Record<string, any>;
}

/**
 * Handle on an execution that has been dispatched.
 *
 * `executeConfig` deliberately resolves as soon as the call is in flight — the
 * route answers with a trace id and the generation continues in the background
 * — so this is how a caller learns when the run is actually over, which is
 * what run-scoped resource teardown hangs off.
 */
export interface ExecutionHandle {
  /**
   * Settles when the run is over, successfully or not. Never rejects: a
   * failure is already reported through the trace, and a caller awaiting this
   * only wants to know that it is safe to tear down.
   */
  done: Promise<void>;
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
   * Resolves once the call has been dispatched, not once it has finished. Use
   * the returned {@link ExecutionHandle} to await completion.
   *
   * @param config - The config object returned by the prompt function.
   * @param options - Optional execution options (trace id, prompt identity,
   *   resolved execute values).
   */
  executeConfig(
    config: any,
    options?: ExecuteConfigOptions,
  ): Promise<ExecutionHandle | undefined>;

  /**
   * Called once, during server startup, before any prompt config is built,
   * to perform whatever setup this SDK's tracing mechanism needs
   * (e.g. registering a native telemetry integration, or standing up an
   * OpenTelemetry pipeline).
   *
   * If this SDK's tracing is built on OpenTelemetry, its implementation of
   * this method should call {@link setupGlobalOTelPipeline}, which
   * ensures the global pipeline is only set up once, even if other SDK adapters
   * also call it.
   *
   * Optional — adapters with no tracing support may omit it.
   *
   * @returns An ingestor to which {@link TraceSink}s should be added, or
   *   `undefined` if tracing cannot be set up.
   */
  setupTraceIngestion?(): Promise<TraceIngestor | undefined>;

  /**
   * Convert a low-level {@link ParsedPrompt} produced by a
   * {@link PromptFileType} into a {@link NormalizedPrompt} that the UI can
   * consume without knowing the SDK's specific property names or message shape.
   *
   * Stays synchronous: the expensive, asynchronous work of resolving probes
   * happens in the provider, which passes the results back in.
   *
   * @param prompt - The raw parsed prompt.
   * @param executeParameters - What this prompt's
   *   {@link getExecuteParameterProbes} resolved to, in the order the probes
   *   were returned: a {@link PropDefinition}, `null` for "no such
   *   requirement", or `undefined` for "could not be evaluated". Absent when
   *   the file type cannot evaluate probes at all — which an adapter should
   *   treat the same as `undefined`, declaring the parameter with an
   *   unresolved type rather than omitting it.
   */
  normalizePrompt(
    prompt: ParsedPrompt,
    executeParameters?: readonly (PropDefinition | null | undefined)[],
  ): NormalizedPrompt;

  /**
   * Returns the type expressions to evaluate in order to discover this
   * prompt's **execute parameters** — the named values this SDK needs at run
   * time that the prompt function's signature cannot express.
   *
   * The file type declares the language and this method is asked *in* it, so
   * the decision of whether the expression can be written at all belongs here,
   * where the SDK knowledge is. Return `[]` for a language this adapter does
   * not speak, rather than emitting every variant and hoping.
   *
   * Optional — an SDK whose configs are self-contained omits it.
   *
   * @param prompt - The parsed prompt to probe.
   * @param language - The file type's {@link PromptFileType.language}.
   */
  getExecuteParameterProbes?(
    prompt: ParsedPrompt,
    language: string,
  ): TypeProbe[];

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

/**
 * Whether `err` is Node's "package not installed" error for `packageName`
 * itself, as opposed to a resolution failure *inside* that package (a broken
 * transitive dependency), which is a real error worth surfacing.
 *
 * Used to tell an uninstalled optional peer dependency apart from a genuine
 * failure when lazily importing one.
 */
export function isMissingPackage(err: unknown, packageName: string): boolean {
  return (
    (err as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND" &&
    (err as Error)?.message?.includes(`'${packageName}'`)
  );
}

/**
 * Message shown when an optional peer dependency an adapter needs is missing.
 */
export function missingPackageMessage(packageName: string): string {
  return (
    `The \`${packageName}\` package isn't installed in this project. ` +
    `Run \`npm install ${packageName}\` to execute these prompts.`
  );
}
