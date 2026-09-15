// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";
import type { TaskId } from "./handle-types.ts";

/** A prompt taking the `taskId` `seeded-task.playground.ts#seededTask` produces. */
export function orchestrate(taskId: TaskId) {
  return {
    model: openai("gpt-4o"),
    system: `Work on ${taskId}`,
    messages: [{ role: "user", content: "Go" }],
  };
}
