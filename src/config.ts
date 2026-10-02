// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { DatasetProvider } from "./dataset/dataset-provider.ts";
import type { EvalProvider } from "./eval/eval-provider.ts";
import type { PromptProvider } from "./prompt/prompt-provider.ts";
import type { TraceProvider } from "./trace/trace-provider.ts";

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
   * If omitted, a {@link LocalDatabaseTraceProvider} is used, which creates a
   * SQLite database under `.evalution/traces/local.db` by default. Nothing
   * is written to disk until the first trace is actually recorded. Use
   * {@link MemoryTraceProvider} instead for ephemeral, in-process-only
   * storage (e.g. in tests).
   */
  traceProviders?: TraceProvider[];

  /**
   * One or more providers that store datasets — collections of input rows
   * captured from the playground or from traces.
   *
   * If omitted, a {@link LocalDirectoryDatasetProvider} is used, which keeps
   * one SQLite file per dataset under `.evalution/datasets/`. Nothing is
   * written to disk until the first dataset is created; the directory then
   * gets a `.gitignore` of its own, so datasets stay out of git.
   */
  datasetProviders?: DatasetProvider[];

  /**
   * One or more providers that store evals — a prompt, a dataset and a set
   * of checks — and their runs' results. See `specs/evals.md`.
   *
   * If omitted, a {@link LocalEvalProvider} is used, which keeps every eval
   * in one SQLite file at `.evalution/evals/evals.db`. Nothing is written to
   * disk until the first eval is created; the directory then gets a
   * `.gitignore` of its own, so evals stay out of git.
   */
  evalProviders?: EvalProvider[];
}
