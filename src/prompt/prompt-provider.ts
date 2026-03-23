import type { ParsedPrompt, PromptChangeEvent, PropDefinition, AddPromptContext, ModelCatalog } from '../shared/types.ts';

/**
 * A source of prompts that the playground can display and execute.
 *
 * Implement this interface to add a custom prompt source — for example,
 * prompts stored in a database, fetched from a remote API, or written in a
 * non-TypeScript format.
 */
export interface PromptProvider<TParsedPrompt extends ParsedPrompt = ParsedPrompt> {
  /** Uniquely identifies this provider when multiple providers are used. */
  readonly id: string;

  /** Human-readable name shown when choosing between providers. */
  readonly displayName?: string;

  /** Short description of what this provider offers. */
  readonly description?: string;

  /** SVG icon markup for this provider. */
  readonly icon?: string;

  /** Returns all prompts currently available from this provider. */
  getAllPrompts(): Promise<TParsedPrompt[]>;

  /**
   * Returns the prompt with the given ID, or `null` if not found.
   * @param id - The prompt's unique identifier.
   */
  getPrompt(id: string): Promise<TParsedPrompt | null>;

  /**
   * Updates one or more properties of a prompt in its source and returns the
   * updated prompt. Setting a property value to `null` removes it.
   *
   * This method is optional; providers that do not support in-place editing
   * may omit it.
   *
   * @param promptId - ID of the prompt to update.
   * @param updates - Map of property names to new values (`null` removes the property).
   */
  updatePromptProperties?(
    promptId: string,
    updates: Record<string, any>
  ): Promise<TParsedPrompt>;

  /**
   * Executes a prompt and returns either a result object (when `stream` is
   * `false`) or an async text iterable (when `stream` is `true`).
   *
   * @param promptId - ID of the prompt to run.
   * @param params - Positional arguments forwarded to the prompt function.
   * @param stream - When `true`, the return value is an async text iterator.
   */
  execute(promptId: string, params: any[], stream: boolean): Promise<any>;

  /**
   * Returns the model catalog (known providers and popular models) for this
   * provider's underlying SDK.
   *
   * Optional — providers that do not expose model info may omit it.
   */
  getModelCatalog?(): Promise<ModelCatalog>;

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
   * prompt and returns the full {@link ParsedPrompt}. Otherwise it returns
   * an {@link AddPromptContext} whose `fields` describe the form the UI
   * should present to the user.
   *
   * Optional — providers that do not support creating prompts may omit it.
   *
   * @param partial - Partially filled prompt data.
   */
  addPrompt?(partial: Partial<TParsedPrompt>): Promise<TParsedPrompt | AddPromptContext>;

  /**
   * Renames a prompt and returns the updated prompt with its new ID.
   *
   * Optional — providers that do not support renaming may omit it.
   *
   * @param promptId - ID of the prompt to rename.
   * @param newName - The new name for the prompt.
   */
  renamePrompt?(promptId: string, newName: string): Promise<TParsedPrompt>;
}
