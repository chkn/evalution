// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

export function promptOne() {
  return {
    model: openai("gpt-4o"),
    system: "First prompt",
    messages: [{ role: "user", content: "Test 1" }],
  };
}

export function promptTwo() {
  return {
    model: anthropic("claude-sonnet-4-20250514"),
    system: "Second prompt",
    messages: [{ role: "user", content: "Test 2" }],
  };
}
