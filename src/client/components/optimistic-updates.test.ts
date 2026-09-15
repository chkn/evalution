// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { NormalizedPrompt } from "../../shared/types";
import { applyOptimisticUpdates } from "./optimistic-updates";

const PROMPT: NormalizedPrompt = {
  id: "p.prompt.ts#p",
  name: "p",
  providerId: "file",
  model: {
    kind: "functionCall",
    callee: "openai",
    args: [{ kind: "primitive", value: "gpt-4o" }],
  },
  modelEditable: true,
  system: { kind: "primitive", value: "Be brief." },
  systemEditable: true,
  messages: [],
  messagesEditable: true,
  modelParameters: [],
  functionParameters: [],
} as unknown as NormalizedPrompt;

describe("applyOptimisticUpdates", () => {
  it("applies a model change immediately", () => {
    const model = {
      kind: "functionCall" as const,
      callee: "anthropic",
      binding: [
        { kind: "import" as const, module: "@ai-sdk/anthropic" },
        { kind: "import" as const, module: "@ai-sdk/anthropic/other" },
      ],
      args: [{ kind: "primitive" as const, value: "claude-opus-5" }],
    };
    const next = applyOptimisticUpdates(PROMPT, { model } as any);
    expect(next.model).toEqual(model);
    expect(next).not.toBe(PROMPT);
    expect(PROMPT.model).toMatchObject({ callee: "openai" });
  });

  it("removes the model on null", () => {
    const next = applyOptimisticUpdates(PROMPT, { model: null });
    expect("model" in next).toBe(false);
  });

  it("applies system and message changes", () => {
    const system = { kind: "primitive" as const, value: "Be verbose." };
    const messages = [
      { role: "user", content: { kind: "primitive" as const, value: "hi" } },
    ];
    const next = applyOptimisticUpdates(PROMPT, { system, messages });
    expect(next.system).toEqual(system);
    expect(next.messages).toEqual(messages);
  });

  it("leaves the prompt untouched for updates it cannot predict", () => {
    const next = applyOptimisticUpdates(PROMPT, {
      modelParameters: { temperature: { kind: "primitive", value: 0.5 } },
    });
    expect(next).toBe(PROMPT);
  });
});
