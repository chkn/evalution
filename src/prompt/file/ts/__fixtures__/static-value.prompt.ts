// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";
import type { WorkspaceId } from "./handle-types.ts";

/**
 * A prompt whose only parameter is filled by a static `value` resource (no
 * `create()`) in `static-value.playground.ts`, matched by type the same way
 * a `create()`-based resource would be.
 */
export function orchestrate(workspaceId: WorkspaceId) {
  return {
    model: openai("gpt-4o"),
    system: `Work in ${workspaceId}`,
    messages: [{ role: "user", content: "Go" }],
  };
}
