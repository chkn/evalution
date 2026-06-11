// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";

function getSystemPrompt() {
  return "Dynamic system prompt";
}

export function dynamicPrompt() {
  return {
    model: openai("gpt-4o"),
    system: getSystemPrompt(),
    messages: [{ role: "user", content: "Test" }],
  };
}
