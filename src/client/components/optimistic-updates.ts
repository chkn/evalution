// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PropValue,
} from "../../shared/types";

/**
 * Apply `updates` to `prompt` locally, ahead of the server's response.
 *
 * Saving re-parses and re-type-checks the prompt file on the server, which can
 * take a second or more, so the editor shows the edit immediately and the
 * server's normalized prompt replaces it once it arrives.
 */
export function applyOptimisticUpdates(
  prompt: NormalizedPrompt,
  updates: NormalizedPromptUpdates,
): NormalizedPrompt {
  let next: NormalizedPrompt | undefined;

  if ("model" in updates) {
    next ??= { ...prompt };
    if (updates.model == null) {
      delete next.model;
    } else {
      // A catalog value may still carry candidate bindings; they only matter
      // when writing source, and the server's response replaces this value.
      next.model = updates.model as PropValue;
    }
  }

  if ("system" in updates) {
    next ??= { ...prompt };
    if (updates.system == null) {
      delete next.system;
    } else {
      next.system = updates.system;
    }
  }

  if ("messages" in updates) {
    next ??= { ...prompt };
    next.messages = updates.messages ?? [];
  }

  return next ?? prompt;
}
