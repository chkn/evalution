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

  // Update one or more properties in a prompt (optional — supported if implemented)
  updatePromptProperties?(
    promptId: string,
    updates: Record<string, any>
  ): Promise<ParsedPrompt>;

  // Watch for changes (optional — supported if implemented)
  watch?(callback: (event: PromptChangeEvent) => void): () => void;
}
