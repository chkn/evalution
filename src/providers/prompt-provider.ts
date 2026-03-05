import type { ParsedPrompt, ModelParameterInfo } from '../shared/types.ts';

/** The kind of change that occurred to a prompt. */
export type ChangeEventType = 'change' | 'add' | 'remove';

/**
 * Describes a single change emitted by {@link PromptProvider.watch}.
 */
export interface PromptChangeEvent {
  /** Whether the prompt was added, modified, or removed. */
  type: ChangeEventType;
  /** The ID of the affected prompt. */
  promptId: string;
}

/**
 * A source of prompts that the playground can display and execute.
 *
 * Implement this interface to add a custom prompt source — for example,
 * prompts stored in a database, fetched from a remote API, or written in a
 * non-TypeScript format. The built-in {@link FilePromptProvider} implements
 * this interface for local `.prompt.ts` files.
 */
export interface PromptProvider<TParsedPrompt extends ParsedPrompt = ParsedPrompt> {
  /** Uniquely identifies this provider when multiple providers are composed together. */
  readonly id: string;

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
   * Returns the list of editable model parameters exposed by this provider's
   * underlying SDK (e.g. `temperature`, `maxTokens`).
   *
   * Optional — providers that do not expose model parameters may omit it.
   */
  getModelParameters?(): ModelParameterInfo[];

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
}
