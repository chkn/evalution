// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";
import type { ThreadMessage } from "./thread-types.ts";

export function summarize(
  title: string,
  _taskInfo: { description?: string | null },
  _threadMsgs: readonly Pick<ThreadMessage, "excerpt">[],
) {
  return {
    model: openai("gpt-4o"),
    system: `Summarize the thread titled ${title}`,
    messages: [{ role: "user", content: "Go" }],
  };
}
