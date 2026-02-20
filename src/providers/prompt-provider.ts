import type { ParsedPrompt } from '../shared/types.ts';

export interface PromptChangeEvent {
  type: 'change' | 'add' | 'remove';
  promptId: string;
}

export interface PromptProvider {
  // Get all available prompts
  getAllPrompts(): Promise<ParsedPrompt[]>;

  // Get a specific prompt by ID
  getPrompt(id: string): Promise<ParsedPrompt | null>;

  // Update one or more properties in a prompt
  updatePromptProperties(
    promptId: string,
    updates: Record<string, any>
  ): Promise<ParsedPrompt>;

  // Watch for changes (optional, for providers that support it)
  watch?(callback: (event: PromptChangeEvent) => void): () => void;

  // Check if provider supports editing
  readonly supportsEditing: boolean;

  // Check if provider supports hot reload
  readonly supportsWatching: boolean;
}
