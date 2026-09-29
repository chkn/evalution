// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** Normalized prompts for the variation tests. */

import type { NormalizedChatPrompt, PropValue } from "../../shared/types.ts";

const str = (value: string): PropValue => ({ kind: "primitive", value });
const num = (value: number): PropValue => ({ kind: "primitive", value });

/** A chat prompt with `system` "base" and `temperature` 0.5. */
export function chatPrompt(
  overrides: Partial<NormalizedChatPrompt> = {},
): NormalizedChatPrompt {
  return {
    id: "p.prompt.ts#p",
    name: "p",
    style: "chat",
    functionParameters: [],
    model: str("openai/gpt-4o"),
    modelEditable: true,
    modelParameters: [
      {
        def: {
          name: "temperature",
          type: { kind: "primitive", syntax: "number", base: "number" },
          optional: true,
        } as any,
        value: num(0.5),
      },
    ],
    system: str("base"),
    systemEditable: true,
    messages: [],
    messagesEditable: true,
    ...overrides,
  };
}
