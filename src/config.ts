import type { PromptProvider } from './providers/prompt-provider.ts';

export interface EvalutionConfig {
  promptProviders?: PromptProvider[];
}
