// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  NormalizedPrompt,
  NormalizedPromptUpdates,
} from "../../shared/types";

/**
 * Apply `updates` to `prompt` locally, ahead of the server's response.
 *
 * Saving re-parses and re-type-checks the prompt file on the server, which can
 * take a second or more, so the editor shows the edit immediately and the
 * server's normalized prompt replaces it once it arrives.
 *
 * Updates written for a different style than the prompt's are left for the
 * server to reject rather than guessed at.
 */
export function applyOptimisticUpdates(
  prompt: NormalizedPrompt,
  updates: NormalizedPromptUpdates,
): NormalizedPrompt {
  if (prompt.style !== updates.style) return prompt;

  let next: NormalizedPrompt | undefined;
  const edit = () => (next ??= { ...prompt });

  if ("model" in updates) {
    const target = edit();
    if (updates.model == null) {
      delete target.model;
    } else {
      // A catalog value may still carry candidate bindings; they only matter
      // when writing source, and the server's response replaces this value.
      target.model = updates.model;
    }
  }

  if (prompt.style === "chat" && updates.style === "chat") {
    if ("system" in updates) {
      const target = edit() as typeof prompt;
      if (updates.system == null) delete target.system;
      else target.system = updates.system;
    }
    if ("messages" in updates) {
      const target = edit() as typeof prompt;
      target.messages = updates.messages ?? [];
    }
  } else if (prompt.style === "questions" && updates.style === "questions") {
    if ("state" in updates) {
      const target = edit() as typeof prompt;
      target.state = { ...prompt.state, value: updates.state ?? undefined };
    }
    if ("questions" in updates) {
      const target = edit() as typeof prompt;
      target.questions = {
        ...prompt.questions,
        value: updates.questions ?? undefined,
      };
    }
  }

  return next ?? prompt;
}
