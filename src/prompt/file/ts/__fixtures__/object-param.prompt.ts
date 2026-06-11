// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";

export function userProfile(config: { name: string; age: number }) {
  return {
    model: openai("gpt-4o"),
    system: `User is ${config.name}, age ${config.age}`,
    messages: [{ role: "user", content: `Tell me about ${config.name}` }],
    temperature: 0.7,
  };
}
