// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  CONFIG_FILE_RELATIVE_PATH,
  type SetupStep,
  type SetupTask,
} from "../shared/setup-task.ts";

const VERCEL_CONFIG = `import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider } from 'evalution';
import { VercelAISDK } from '@evalution/vercel-ai-sdk/config';

export default {
  promptProviders: [
    new FilePromptProvider({
      sdk: new VercelAISDK(),
    }),
  ],
} satisfies EvalutionConfig;
`;

const TYPESAFE_CONFIG = `import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider } from 'evalution';
import { TypeSafeSDK } from '@evalution/typesafe-sdk/config';

// Running prompts needs a TypeSafe API key: set TYPESAFE_API_KEY in the
// environment you start evalution from.
export default {
  promptProviders: [
    new FilePromptProvider({
      sdk: new TypeSafeSDK(),
    }),
  ],
} satisfies EvalutionConfig;
`;

/**
 * Every AI SDK offered in manual onboarding, in display order, and the single
 * source of truth for their task ids. Plain data rather than something the
 * adapters carry: onboarding runs before an adapter package is installed.
 */
export const AI_SDK_SETUP_TASKS: readonly SetupTask[] = [
  {
    id: "vercel-ai-sdk",
    label: "AI SDK",
    icon: "vercel",
    steps: [
      { kind: "install_package", id: "install-ai", package: "ai" },
      {
        kind: "install_package",
        id: "install-evalution-vercel-ai-sdk",
        package: "@evalution/vercel-ai-sdk",
      },
      {
        kind: "create_config",
        id: "create-config",
        path: CONFIG_FILE_RELATIVE_PATH,
        contents: VERCEL_CONFIG,
      },
    ],
  },
  {
    id: "typesafe-sdk",
    label: "TypeSafe",
    icon: "TypeSafe",
    steps: [
      {
        kind: "install_package",
        id: "install-typesafe-sdk",
        package: "@typesafe-ai/sdk",
      },
      {
        kind: "install_package",
        id: "install-evalution-typesafe-sdk",
        package: "@evalution/typesafe-sdk",
      },
      {
        kind: "create_config",
        id: "create-config",
        path: CONFIG_FILE_RELATIVE_PATH,
        contents: TYPESAFE_CONFIG,
      },
    ],
  },
];

/** Look up a {@link SetupTask} by its id, or `undefined` if none matches. */
export function findSetupTask(taskId: string): SetupTask | undefined {
  return AI_SDK_SETUP_TASKS.find(task => task.id === taskId);
}

/**
 * Look up a step within a task by both ids, or `undefined` if either is
 * unknown.
 */
export function findSetupStep(
  taskId: string,
  stepId: string,
): SetupStep | undefined {
  return findSetupTask(taskId)?.steps.find(s => s.id === stepId);
}
