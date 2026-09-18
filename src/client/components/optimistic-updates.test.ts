// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type {
  NormalizedChatPrompt,
  NormalizedPrompt,
} from "../../shared/types";
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
  style: "chat",
  modelEditable: true,
  system: { kind: "primitive", value: "Be brief." },
  systemEditable: true,
  messages: [],
  messagesEditable: true,
  modelParameters: [],
  functionParameters: [],
} as unknown as NormalizedChatPrompt;

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
    const next = applyOptimisticUpdates(PROMPT, {
      style: "chat",
      model,
    } as any);
    expect(next.model).toEqual(model);
    expect(next).not.toBe(PROMPT);
    expect(PROMPT.model).toMatchObject({ callee: "openai" });
  });

  it("removes the model on null", () => {
    const next = applyOptimisticUpdates(PROMPT, { style: "chat", model: null });
    expect("model" in next).toBe(false);
  });

  it("applies system and message changes", () => {
    const system = { kind: "primitive" as const, value: "Be verbose." };
    const messages = [
      { role: "user", content: { kind: "primitive" as const, value: "hi" } },
    ];
    const next = applyOptimisticUpdates(PROMPT, {
      style: "chat",
      system,
      messages,
    }) as NormalizedChatPrompt;
    expect(next.system).toEqual(system);
    expect(next.messages).toEqual(messages);
  });

  it("leaves the prompt untouched for updates it cannot predict", () => {
    const next = applyOptimisticUpdates(PROMPT, {
      style: "chat",
      modelParameters: { temperature: { kind: "primitive", value: 0.5 } },
    });
    expect(next).toBe(PROMPT);
  });

  it("ignores updates written for another style", () => {
    const next = applyOptimisticUpdates(PROMPT, {
      style: "questions",
      questions: { kind: "object", properties: {} },
    });
    expect(next).toBe(PROMPT);
  });

  it("applies state and questions changes to a questions prompt", () => {
    const prompt: NormalizedPrompt = {
      style: "questions",
      id: "q.prompt.ts#q",
      name: "q",
      functionParameters: [],
      modelEditable: true,
      modelParameters: [],
      state: {
        def: {
          name: "state",
          optional: false,
          type: { kind: "primitive", syntax: "string" },
        },
      },
      stateEditable: true,
      questions: {
        def: {
          name: "questions",
          optional: false,
          type: { kind: "primitive", syntax: "Questions" },
        },
      },
      questionsEditable: true,
    };
    const state = { kind: "primitive" as const, value: "hello" };
    const questions = { kind: "object" as const, properties: {} };
    const next = applyOptimisticUpdates(prompt, {
      style: "questions",
      state,
      questions,
    });
    expect(next).toMatchObject({
      state: { value: state },
      questions: { value: questions },
    });
    expect(prompt.state.value).toBeUndefined();
  });
});
