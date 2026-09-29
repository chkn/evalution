// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  AddPromptContext,
  ConflictChoices,
  ExecutionInput,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PromptChangeEvent,
  PromptRef,
  PromptStyle,
  PropDefinition,
  RebaseResult,
  VariationConflict,
  VariationId,
  VariationInfo,
  VersionId,
  VersionInfo,
} from "../shared/types.ts";
import type { TraceIngestor } from "../trace/trace-ingestor.ts";
import type { PromptFileType } from "./file/prompt-file-type.ts";
import type { VersionHistoryOptions } from "./versioning/versioning-adapter.ts";

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

export type {
  ConflictChoices,
  PromptRef,
  RebaseResult,
  VariationConflict,
  VariationId,
  VariationInfo,
  VersionId,
  VersionInfo,
};

/**
 * A {@link PromptRef}, or a bare prompt id meaning head — accepted wherever a
 * ref is, so a provider with no notion of versions, and most call sites, need
 * not change.
 */
export type PromptRefLike = PromptRef | string;

/** `ref` as a {@link PromptRef}: a bare id is head. */
export function toPromptRef(ref: PromptRefLike): PromptRef {
  return typeof ref === "string" ? { promptId: ref } : ref;
}

/** The prompt id `ref` names. */
export function promptIdOf(ref: PromptRefLike): string {
  return typeof ref === "string" ? ref : ref.promptId;
}

/** What {@link PromptProvider.execute} ran. */
export interface ExecuteResult {
  /** The version the run executed against, when the provider has versions. */
  version?: VersionId;
  /**
   * The variation the run applied on top of {@link version}, if any. Running
   * a variation may first rebase it onto head, so this can differ from the
   * one asked for.
   */
  variation?: VariationId;
}

/**
 * Thrown when a variation can't be applied — to run it, save it, or rebase it
 * — without choosing between two changes to the same field.
 */
export class VariationConflictError extends Error {
  /** The fields that conflicted. */
  readonly conflicts: VariationConflict[];

  constructor(conflicts: VariationConflict[]) {
    super(
      `The variation conflicts with the working tree on ${conflicts
        .map(c => `'${c.field}'`)
        .join(", ")}`,
    );
    this.name = "VariationConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * A provider's ability to name states of the world. See
 * `specs/prompt-versions-and-variations.md` §B.
 */
export interface PromptVersions {
  /**
   * Pins head as a version and returns it. Cheap when nothing changed since
   * the last call.
   *
   * @param promptId - The prompt the caller is about to depend on. A
   *   provider that versions single files rather than the whole project
   *   needs it.
   */
  snapshot(promptId?: string): Promise<VersionInfo>;
  /**
   * Versions that changed this prompt's file, newest first — what a version
   * selector lists. Never every version: most don't touch any one prompt.
   */
  history(
    promptId: string,
    options?: VersionHistoryOptions,
  ): Promise<VersionInfo[]>;
  /** Describes a version, or `undefined` when there is no such version. */
  get(id: VersionId): Promise<VersionInfo | undefined>;
}

/**
 * A provider's ability to hold edits apart from the source. See
 * `specs/prompt-versions-and-variations.md` §B and §G.
 */
export interface PromptVariations {
  /** The variation with this id, frozen or WIP. */
  get(id: VariationId): Promise<VariationInfo | undefined>;
  /** A prompt's named variations, plus its WIP ones. */
  list(promptId: string): Promise<VariationInfo[]>;
  /**
   * Names a variation. A name is unique per prompt, and naming again moves
   * it. Naming a WIP freezes its current updates and names the frozen row;
   * the WIP carries on.
   */
  name(id: VariationId, name: string): Promise<VariationInfo>;
  /** Removes a name. */
  unname(promptId: string, name: string): Promise<void>;
  /** Re-expresses `id` against `onto` (default: head). */
  rebase(id: VariationId, onto?: VersionId): Promise<RebaseResult>;
  /**
   * Brings `id`'s changes into the head WIP: rebases onto head, then merges
   * into the WIP if one exists. Returns the WIP.
   *
   * When a field conflicts — the unsaved edits, or head itself, set it
   * differently — nothing changes: the conflicts come back, labelled, for the
   * caller to settle through `options` in a second call.
   */
  openOnHead(
    id: VariationId,
    options?: OpenOnHeadOptions,
  ): Promise<RebaseResult>;
  /**
   * Brings an old version's prompt into the head WIP — its field values, as
   * edits to head — with the same merge as {@link openOnHead}.
   */
  openVersionOnHead(
    promptId: string,
    version: VersionId,
    options?: OpenOnHeadOptions,
  ): Promise<RebaseResult>;
  /** Rebases the head WIP onto head, writes it into the source, and deletes it. */
  save(wipId: VariationId): Promise<RebaseResult>;
  /** Drops a WIP variation. Frozen variations are never deleted. */
  discard(id: VariationId): Promise<void>;
  /** Settles a WIP's pending conflicts with a choice per field. */
  resolve(id: VariationId, choices: ConflictChoices): Promise<RebaseResult>;
}

/** How to settle conflicts when opening a variation or version on head. */
export interface OpenOnHeadOptions {
  /**
   * Discard the unsaved edits at head first, so what's opened is exactly the
   * variation or version.
   */
  replace?: boolean;
  /** Which side to keep for each conflicting field. */
  choices?: ConflictChoices;
}

/** What {@link PromptProvider.updatePromptProperties} hands back. */
export interface UpdatePromptResult<
  TPrompt extends NormalizedPrompt = NormalizedPrompt,
> {
  /** The prompt as the updates left it. */
  prompt: TPrompt;
  /** Where the updates landed — the ref to keep editing at. */
  ref: PromptRef;
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
   * Returns the prompt `ref` names, or `null` if not found.
   * @param ref - Which prompt, in which state. A bare id means head.
   */
  getPrompt(ref: PromptRefLike): Promise<TPrompt | null>;

  /**
   * Applies normalized updates to the prompt `ref` names, and returns where
   * they landed. Setting any field of `updates` to `null` removes the
   * corresponding property.
   *
   * On a provider with {@link variations}, this never writes the source: it
   * updates (or creates) the WIP variation for `ref`'s base, and the source
   * is written only by an explicit {@link PromptVariations.save}. Without
   * variations, it writes the source.
   *
   * This method is optional; providers that do not support editing may omit
   * it.
   *
   * @param ref - The prompt to update. A bare id means head.
   * @param updates - Updates expressed in the normalized vocabulary.
   */
  updatePromptProperties?(
    ref: PromptRefLike,
    updates: NormalizedPromptUpdates,
  ): Promise<UpdatePromptResult<TPrompt>>;

  /**
   * Executes a prompt.
   *
   * Receives plain materialized values — a provider never has to recognise an
   * {@link ExecutionInput} or interpret someone else's `uri` grammar.
   * Resolution happens before this is called, through
   * {@link resolveInputs} where a provider offers one.
   *
   * Returns what it ran — the version, and the variation if any — which the
   * caller records. A provider without versions may return nothing.
   *
   * @param ref - The prompt to run. A bare id means head.
   * @param params - Positional arguments forwarded to the prompt function.
   * @param options - Optional execution settings; see {@link ExecuteOptions}.
   */
  execute(
    ref: PromptRefLike,
    params: any[],
    options?: ExecuteOptions,
    // biome-ignore lint/suspicious/noConfusingVoidType: a provider with no versions keeps its `async execute() {}` as it was
  ): Promise<ExecuteResult | void>;

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
   * @param ref - The prompt the inputs are for. A bare id means head.
   * @param inputs - The unresolved inputs. See {@link ExecutionInput}.
   */
  resolveInputs?(
    ref: PromptRefLike,
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
   * SDK, catalogs included, for prompts of the given style. See
   * `SDKAdapter.getModelDefinition`.
   *
   * Optional — providers that do not expose model info may omit it.
   */
  getModelDefinition?(style: PromptStyle): Promise<PropDefinition>;

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

  /** Present when this provider can name states of the world. */
  readonly versions?: PromptVersions;

  /** Present when this provider can hold edits apart from the source. */
  readonly variations?: PromptVariations;
}
