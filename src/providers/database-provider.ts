import { PromptProvider } from './prompt-provider.ts';
import { ParsedPrompt } from '../shared/types.ts';

export class DatabasePromptProvider implements PromptProvider {
  readonly supportsEditing = true;
  readonly supportsWatching = false;

  constructor(private connectionString: string) {}

  async getAllPrompts(): Promise<ParsedPrompt[]> {
    throw new Error('Database provider not yet implemented');
  }

  async getPrompt(id: string): Promise<ParsedPrompt | null> {
    throw new Error('Database provider not yet implemented');
  }

  async updatePromptProperties(
    promptId: string,
    updates: Record<string, any>
  ): Promise<ParsedPrompt> {
    throw new Error('Database provider not yet implemented');
  }
}
