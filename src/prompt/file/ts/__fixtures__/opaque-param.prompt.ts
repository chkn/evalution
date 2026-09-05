// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";
import type { Db, TaskId } from "./handle-types.ts";

/**
 * A prompt taking both an unconstructible handle and a perfectly editable
 * branded id, so the two can be told apart.
 */
export function orchestrate(
  taskId: TaskId,
  ctx: { db: Db; workspaceId: string },
) {
  return {
    model: openai("gpt-4o"),
    system: `Work on ${taskId} in ${ctx.workspaceId}`,
    messages: [{ role: "user", content: "Go" }],
  };
}
