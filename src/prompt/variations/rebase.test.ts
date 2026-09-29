// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { PropValue } from "../../shared/types.ts";
import {
  mergeIntoWip,
  PROMPT_FIELD,
  rebaseUpdates,
  resolveConflicts,
} from "./rebase.ts";
import { chatPrompt } from "./test-prompts.ts";

const str = (value: string): PropValue => ({ kind: "primitive", value });

describe("rebaseUpdates", () => {
  it("takes the variation's value when only the variation changed the field", () => {
    const base = chatPrompt();
    const target = chatPrompt({ model: str("openai/gpt-5") }); // unrelated change
    const result = rebaseUpdates(base, target, {
      style: "chat",
      system: str("mine"),
    });
    expect(result).toEqual({
      ok: true,
      updates: { style: "chat", system: str("mine") },
    });
  });

  it("drops a field both sides changed the same way", () => {
    const base = chatPrompt();
    const target = chatPrompt({ system: str("same") });
    const result = rebaseUpdates(base, target, {
      style: "chat",
      system: str("same"),
    });
    expect(result).toEqual({ ok: true, updates: { style: "chat" } });
  });

  it("conflicts on a field both sides changed differently, carrying all three values", () => {
    const base = chatPrompt();
    const target = chatPrompt({ system: str("theirs") });
    const result = rebaseUpdates(base, target, {
      style: "chat",
      system: str("mine"),
      model: str("openai/gpt-5"),
    });
    expect(result).toEqual({
      ok: false,
      updates: { style: "chat", model: str("openai/gpt-5") },
      conflicts: [
        {
          field: "system",
          base: str("base"),
          target: str("theirs"),
          variation: str("mine"),
        },
      ],
    });
  });

  it("merges model parameters per key", () => {
    const base = chatPrompt();
    const target = chatPrompt({ system: str("theirs") });
    const result = rebaseUpdates(base, target, {
      style: "chat",
      modelParameters: { temperature: { kind: "primitive", value: 1 } },
    });
    expect(result.ok).toBe(true);
    expect(result.updates.modelParameters).toEqual({
      temperature: { kind: "primitive", value: 1 },
    });
  });

  it("conflicts on the prompt itself when it doesn't exist at the target", () => {
    const result = rebaseUpdates(chatPrompt(), undefined, {
      style: "chat",
      system: str("mine"),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.conflicts.map(c => c.field)).toEqual([
      PROMPT_FIELD,
    ]);
  });
});

describe("mergeIntoWip", () => {
  it("merges disjoint fields and conflicts on a field both set differently", () => {
    const head = chatPrompt();
    const result = mergeIntoWip(
      head,
      { style: "chat", system: str("unsaved") },
      { style: "chat", system: str("named"), model: str("openai/gpt-5") },
    );
    expect(result).toEqual({
      ok: false,
      updates: {
        style: "chat",
        system: str("unsaved"),
        model: str("openai/gpt-5"),
      },
      conflicts: [
        {
          field: "system",
          base: str("base"),
          target: str("unsaved"),
          variation: str("named"),
        },
      ],
    });
  });
});

describe("resolveConflicts", () => {
  const head = chatPrompt({ system: str("theirs") });
  const pending = {
    onto: "v2",
    updates: { style: "chat" as const, model: str("openai/gpt-5") },
    conflicts: [
      {
        field: "system",
        base: str("base"),
        target: str("theirs"),
        variation: str("mine"),
      },
    ],
    labels: { target: "head", variation: "yours" },
  };

  it("keeping the target's value leaves nothing to apply for that field", () => {
    expect(resolveConflicts(head, pending, { system: "target" })).toEqual({
      style: "chat",
      model: str("openai/gpt-5"),
    });
  });

  it("keeping the variation's value applies it", () => {
    expect(resolveConflicts(head, pending, { system: "variation" })).toEqual({
      style: "chat",
      model: str("openai/gpt-5"),
      system: str("mine"),
    });
  });

  it("refuses a conflict left without a choice", () => {
    expect(() => resolveConflicts(head, pending, {})).toThrow(/system/);
  });
});
