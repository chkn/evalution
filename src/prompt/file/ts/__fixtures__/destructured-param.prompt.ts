// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { openai } from "@ai-sdk/openai";

export function userGreeting({ name, age }: { name: string; age: number }) {
  return {
    model: openai("gpt-4o"),
    system: `Greet a user named ${name} who is ${age} years old`,
    messages: [{ role: "user", content: `Hello, I'm ${name}` }],
  };
}
