// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  AddPromptContext,
  ExecutionInput,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PromptChangeEvent,
  PropDefinition,
} from "../shared/types.ts";
import type { TraceIngestor } from "../trace/trace-ingestor.ts";
import type { PromptFileType } from "./file/prompt-file-type.ts";

/**
 * Optional settings for {@link PromptProvider.execute}.
 */
export interface ExecuteOptions {
  /** The ID to use for the trace created by this execution, if any. */
  traceId?: string;
  /** The ID of this execution's root span. See `ExecuteConfigOptions.rootSpanId`. */
  rootSpanId?: string;
  /**
   * Named values the SDK needs to execute the prompt's config, keyed by
   * execute-parameter name. Forwarded to the SDK adapter, which knows how they
   * reach the underlying call.
   */
  executeValues?: Record<string, any>;
  /**
   * The unresolved inputs these values came from, recorded on the trace so a
   * past run can be read back as the recipe it ran with rather than as a
   * snapshot of values that may not even be serializable.
   */
  inputs?: {
    functionInputs?: readonly ExecutionInput[];
    executeInputs?: Record<string, ExecutionInput>;
  };
  /**
   * Called once the run is over, successfully or not.
   *
   * {@link PromptProvider.execute} resolves as soon as the run is dispatched —
   * the route answers with a trace id and the generation continues in the
   * background — so this is the only signal that anything scoped to the run
   * (a resource created for it) may now be torn down. A provider that cannot
   * detect completion should call it immediately rather than never.
   */
  onSettled?: () => void;
}

/** What {@link PromptProvider.resolveInputs} hands back. */
export interface ResolvedPromptInputs {
  /** Positional arguments for {@link PromptProvider.execute}. */
  functionParams: any[];
  /** Named values for {@link ExecuteOptions.executeValues}. */
  executeValues: Record<string, any>;
  /**
   * Serializable summaries of what any resources produced, keyed by `uri`, so
   * a trace can show the value a run used even though replaying it would mint
   * a new one.
   */
  receipts?: Record<string, unknown>;
  /**
   * Releases anything the resolution created that is scoped to this run.
   * Called once the run settles.
   */
  release?(): Promise<void>;
}

/**
 * A source of prompts that the playground can display and execute.
 *
 * Implement this interface to add a custom prompt source — for example,
 * prompts stored in a database or fetched from a remote API. If you simply
 * need to support a file format other than TypeScript, use {@link FilePromptProvider}
 * with a custom {@link PromptFileType}.
 */
export interface PromptProvider<
  TPrompt extends NormalizedPrompt = NormalizedPrompt,
> {
  /** Uniquely identifies this provider when multiple providers are used. */
  readonly id: string;

  /** Human-readable name shown when choosing between providers. */
  readonly displayName?: string;

  /** Short description of what this provider offers. */
  readonly description?: string;

  /** SVG icon markup for this provider. */
  readonly icon?: string;

  /** Returns all prompts currently available from this provider. */
  getAllPrompts(): Promise<TPrompt[]>;

  /**
   * Returns the prompt with the given ID, or `null` if not found.
   * @param id - The prompt's unique identifier.
   */
  getPrompt(id: string): Promise<TPrompt | null>;

  /**
   * Applies normalized updates to a prompt's source and returns the fresh
   * prompt. Setting any field of `updates` to `null` removes the corresponding
   * property from the underlying source.
   *
   * This method is optional; providers that do not support in-place editing
   * may omit it.
   *
   * @param promptId - ID of the prompt to update.
   * @param updates - Updates expressed in the normalized vocabulary.
   */
  updatePromptProperties?(
    promptId: string,
    updates: NormalizedPromptUpdates,
  ): Promise<TPrompt>;

  /**
   * Executes a prompt.
   *
   * Receives plain materialized values — a provider never has to recognise an
   * {@link ExecutionInput} or interpret someone else's `uri` grammar.
   * Resolution happens before this is called, through
   * {@link resolveInputs} where a provider offers one.
   *
   * @param promptId - ID of the prompt to run.
   * @param params - Positional arguments forwarded to the prompt function.
   * @param options - Optional execution settings; see {@link ExecuteOptions}.
   */
  execute(
    promptId: string,
    params: any[],
    options?: ExecuteOptions,
  ): Promise<void>;

  /**
   * Turns the unresolved inputs the playground sends into the concrete values
   * {@link execute} takes.
   *
   * Both halves are resolved in one call rather than one call per half: a
   * run-scoped resource referenced by both a function input and an execute
   * input must be created **once** per run, which is only decidable with every
   * input in view.
   *
   * Optional. Without it, inputs of kind `value` are materialized by a
   * built-in fallback and anything else is rejected — so a provider that has
   * no resources of its own keeps working untouched.
   *
   * @param promptId - ID of the prompt the inputs are for.
   * @param inputs - The unresolved inputs. See {@link ExecutionInput}.
   */
  resolveInputs?(
    promptId: string,
    inputs: {
      functionInputs?: readonly ExecutionInput[];
      executeInputs?: Record<string, ExecutionInput>;
    },
  ): Promise<ResolvedPromptInputs>;

  /**
   * Performs whatever process-global setup this provider's tracing mechanism
   * needs and returns the resulting {@link TraceIngestor}.
   *
   * Optional — providers with no tracing support may omit it.
   */
  setupTraceIngestion?(): Promise<TraceIngestor | undefined>;

  /**
   * Returns the definition of the model slot for this provider's underlying
   * SDK, catalogs included. See `SDKAdapter.getModelDefinition`.
   *
   * Optional — providers that do not expose model info may omit it.
   */
  getModelDefinition?(): Promise<PropDefinition>;

  /**
   * Returns the list of editable model parameters exposed by this provider's
   * underlying SDK (e.g. `temperature`, `maxTokens`).
   *
   * Optional — providers that do not expose model parameters may omit it.
   */
  getModelParameters?(): PropDefinition[];

  /**
   * Registers a callback that is invoked whenever a prompt changes.
   * Returns a cleanup function that stops the watcher when called.
   *
   * Optional — providers that cannot detect live changes may omit it.
   *
   * @param callback - Invoked with a {@link PromptChangeEvent} for each change.
   * @returns A no-argument function that unregisters the watcher.
   */
  watch?(callback: (event: PromptChangeEvent) => void): () => void;

  /**
   * Creates a new prompt from the given partial, or returns an
   * {@link AddPromptContext} describing what additional inputs are needed.
   *
   * When `partial` contains enough information the provider creates the
   * prompt and returns the full {@link NormalizedPrompt}. Otherwise it returns
   * an {@link AddPromptContext} whose `fields` describe the form the UI
   * should present to the user.
   *
   * Optional — providers that do not support creating prompts may omit it.
   *
   * @param partial - Partially filled prompt data.
   */
  addPrompt?(partial: Partial<TPrompt>): Promise<TPrompt | AddPromptContext>;

  /**
   * Renames a prompt and returns the updated prompt with its new ID.
   *
   * Optional — providers that do not support renaming may omit it.
   *
   * @param promptId - ID of the prompt to rename.
   * @param newName - The new name for the prompt.
   */
  renamePrompt?(promptId: string, newName: string): Promise<TPrompt>;
}
