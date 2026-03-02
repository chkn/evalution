import type { ParsedPrompt, ModelParameterInfo } from '../shared/types.ts';

export type ChangeEventType = 'change' | 'add' | 'remove';

export interface PromptChangeEvent {
  type: ChangeEventType;
  promptId: string;
}

export interface PromptProvider {
  readonly id: string;

  // Get all available prompts
  getAllPrompts(): Promise<ParsedPrompt[]>;

  // Get a specific prompt by ID
  getPrompt(id: string): Promise<ParsedPrompt | null>;

  // Update one or more properties in a prompt (optional — supported if implemented)
  updatePromptProperties?(
    promptId: string,
    updates: Record<string, any>
  ): Promise<ParsedPrompt>;

  // Execute a prompt with positional params; returns a result object or a text stream
  execute(promptId: string, params: any[], stream: boolean): Promise<any>;

  // Return the editable model parameters supported by this provider's SDK (optional)
  getModelParameters?(): ModelParameterInfo[];

  // Watch for changes (optional — supported if implemented)
  watch?(callback: (event: PromptChangeEvent) => void): () => void;
}
