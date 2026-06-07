/**
 * Shared, dependency-free helpers for scaffolding an evalution project config.
 *
 * This module is imported by both the browser client (to display a snippet)
 * and the server (to write the file), so it must stay free of any Node- or
 * DOM-specific imports.
 */

/** An AI SDK the user can pick during manual onboarding setup. */
export type AiSdkChoice = 'vercel-ai-sdk';

/** Path, relative to the project root, where evalution looks for its config. */
export const CONFIG_FILE_RELATIVE_PATH = '.evalution/config.ts';

/** URL of the configuration documentation, linked from the onboarding wizard. */
export const CONFIG_DOCS_URL = 'https://evalut.io/n/docs/config';

/** Selectable AI SDK options, in display order, for the manual setup picker. */
export const AI_SDK_OPTIONS: ReadonlyArray<{ value: AiSdkChoice; label: string }> = [
  { value: 'vercel-ai-sdk', label: 'AI SDK' },
];

/**
 * Builds the starter contents of `.evalution/config.ts` for the chosen AI SDK.
 *
 * The result is a complete, type-checking module that can be dropped straight
 * into a project; it is both shown to the user as a copyable snippet and
 * written verbatim when they ask evalution to create the file for them.
 */
export function configFileTemplate(_sdk: AiSdkChoice): string {
  return `import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider, VercelAISDK } from 'evalution';

export default {
  promptProviders: [
    new FilePromptProvider({
      sdk: new VercelAISDK(),
    }),
  ],
} satisfies EvalutionConfig;
`;
}
