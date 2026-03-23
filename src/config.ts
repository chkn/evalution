import type { PromptProvider } from './prompt/prompt-provider.ts';

/**
 * Top-level configuration for an evalution instance.
 *
 * Place a default export of this type in `.evalution/config.ts` at the root
 * of your project to customise how evalution discovers and serves prompts.
 *
 * @example
 * ```ts
 * // .evalution/config.ts
 * import { FilePromptProvider } from 'evalution';
 *
 * const config: EvalutionConfig = {
 *   promptProviders: [
 *     new FilePromptProvider({ rootDir: './prompts' }),
 *   ],
 * };
 * export default config;
 * ```
 */
export interface EvalutionConfig {
  /**
   * One or more providers that supply prompts to the playground.
   *
   * If omitted, a {@link FilePromptProvider} rooted at the current working
   * directory is used automatically.
   */
  promptProviders?: PromptProvider[];
}
