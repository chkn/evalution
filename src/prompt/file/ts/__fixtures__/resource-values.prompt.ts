// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";
import type { TaskId } from "./handle-types.ts";
import type { TaskInfo } from "./resource-values.playground.ts";

/**
 * A prompt taking both `taskId` and `taskInfo` — one seeded task's id and its
 * `{ title, description }`, which `resource-values.playground.ts#taskA`
 * exposes as two separate values off the one row its `create()` inserts.
 */
export function orchestrate(taskId: TaskId, taskInfo: TaskInfo) {
  return {
    model: openai("gpt-4o"),
    system: `Work on ${taskId}: ${taskInfo.title}`,
    messages: [{ role: "user", content: "Go" }],
  };
}
