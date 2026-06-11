// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { SetupStep, SetupTask } from "../shared/setup-task.ts";
import type { SDKAdapter } from "./sdk-adapter.ts";
import { VercelAISDK } from "./vercel-ai-sdk.ts";

/**
 * The static side of an {@link SDKAdapter} class: it must be constructible and
 * carry the {@link SetupTask} that drives onboarding before any instance
 * exists. Membership in {@link AI_SDK_REGISTRY} enforces this shape at compile
 * time.
 */
export interface SDKAdapterClass {
  new (...args: any[]): SDKAdapter;
  /** Onboarding task shown in the manual-setup picker for this SDK. */
  readonly setupTask: SetupTask;
}

/**
 * Every AI SDK offered in manual onboarding, in display order. This is the
 * single source of truth for which SDKs exist and their task ids — adding one
 * to onboarding means giving its adapter a static `setupTask` and listing it
 * here.
 */
export const AI_SDK_REGISTRY: readonly SDKAdapterClass[] = [VercelAISDK];

/** Look up a {@link SetupTask} by its id, or `undefined` if none matches. */
export function findSetupTask(taskId: string): SetupTask | undefined {
  for (const cls of AI_SDK_REGISTRY) {
    if (cls.setupTask.id === taskId) return cls.setupTask;
  }
  return undefined;
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
