/**
 * Shared, dependency-free helpers for scaffolding an evalution project config.
 *
 * This module is imported by both the browser client (to display a snippet)
 * and the server (to write the file), so it must stay free of any Node- or
 * DOM-specific imports.
 */

/** An AI SDK the user can pick during manual onboarding setup. */
export type AiSdkChoice = 'vercel-ai-sdk' | 'other';

/** Path, relative to the project root, where evalution looks for its config. */
export const CONFIG_FILE_RELATIVE_PATH = '.evalution/config.ts';

/** URL of the configuration documentation, linked from the onboarding wizard. */
export const CONFIG_DOCS_URL = 'https://evalut.io/docs/config';

/** Selectable AI SDK options, in display order, for the manual setup picker. */
export const AI_SDK_OPTIONS: ReadonlyArray<{ value: AiSdkChoice; label: string }> = [
  { value: 'vercel-ai-sdk', label: 'Vercel AI SDK' },
  { value: 'other', label: 'Other' },
];

/**
 * Builds the starter contents of `.evalution/config.ts` for the chosen AI SDK.
 *
 * The result is a complete, type-checking module that can be dropped straight
 * into a project; it is both shown to the user as a copyable snippet and
 * written verbatim when they ask evalution to create the file for them.
 */
export function configFileTemplate(sdk: AiSdkChoice): string {
  if (sdk === 'vercel-ai-sdk') {
    return `import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider, VercelAISDK } from 'evalution';

const config: EvalutionConfig = {
  promptProviders: [
    new FilePromptProvider({
      rootDir: './prompts',
      sdk: new VercelAISDK(),
    }),
  ],
};

export default config;
`;
  }

  return `import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider } from 'evalution';

// You selected "Other": implement the SDKAdapter interface for your stack and
// pass an instance as \`sdk\` below. See ${CONFIG_DOCS_URL} for a guide.
const config: EvalutionConfig = {
  promptProviders: [
    new FilePromptProvider({
      rootDir: './prompts',
      // sdk: new YourSDKAdapter(),
    }),
  ],
};

export default config;
`;
}
