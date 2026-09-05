// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";
import { tool } from "ai";
import { z } from "zod";
import type { Db, WorkspaceId } from "./handle-types.ts";

/**
 * A prompt whose tools need run-time context the signature cannot express —
 * the shape that fails at the first tool call without execute parameters.
 */
export function assist(question: string) {
  return {
    model: openai("gpt-4o"),
    system: `Answer: ${question}`,
    tools: {
      lookup: tool({
        description: "Look a task up",
        inputSchema: z.object({ id: z.string() }),
        contextSchema: z.custom<{ db: Db; workspaceId: WorkspaceId }>(),
        execute: async () => "ok",
      }),
      // No `contextSchema`, so this one must not appear in `toolsContext`.
      plain: tool({
        description: "Say hello",
        inputSchema: z.object({}),
        execute: async () => "hi",
      }),
    },
  };
}
