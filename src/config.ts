// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PromptProvider } from './prompt/prompt-provider.ts';
import type { TraceProvider } from './trace/trace-provider.ts';

/**
 * Top-level configuration for an Evalution instance.
 *
 * Place a default export of this type in `.evalution/config.ts` at the root
 * of your project to customise how Evalution discovers and serves prompts
 * and traces.
 * 
 * If no config file is found, Evalution will show an onboarding wizard
 * to help you create one.
 *
 * @example
 * ```ts
 * // .evalution/config.ts
 * import type { EvalutionConfig } from 'evalution';
 * import { FilePromptProvider, VercelAISDK } from 'evalution';
 *
 * export default {
 *   promptProviders: [
 *     new FilePromptProvider({
 *       sdk: new VercelAISDK(),
 *     }),
 *   ],
 * } satisfies EvalutionConfig;
 * ```
 */
export interface EvalutionConfig {
  /**
   * Whether to load a `.env` file from the directory Evalution is launched
   * from before starting the server.
   *
   * @default true
   */
  useDotenv?: boolean;

  /**
   * One or more providers that supply prompts to the playground.
   *
   * If omitted, a {@link FilePromptProvider} rooted at the current working
   * directory is used automatically.
   */
  promptProviders?: PromptProvider[];

  /**
   * One or more providers that supply execution traces to the playground.
   *
   * If omitted, a {@link MemoryTraceProvider} is used automatically so the
   * Traces tab can still be exercised without wiring a real tracing backend.
   */
  traceProviders?: TraceProvider[];
}
