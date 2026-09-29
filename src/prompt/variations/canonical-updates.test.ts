// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { NormalizedPromptUpdates, PropValue } from "../../shared/types.ts";
import {
  canonicalizeUpdates,
  isEmptyUpdates,
  mergeUpdates,
  sameValue,
  serializeUpdates,
} from "./canonical-updates.ts";
import { chatPrompt } from "./test-prompts.ts";

const str = (value: string): PropValue => ({ kind: "primitive", value });
const num = (value: number): PropValue => ({ kind: "primitive", value });

describe("canonicalizeUpdates", () => {
  it("drops a field equal to the base, so edit-then-undo is empty", () => {
    const base = chatPrompt();
    const merged = mergeUpdates(
      { style: "chat", system: str("edited") },
      { style: "chat", system: str("base") },
    );
    const canonical = canonicalizeUpdates(base, merged);
    expect(isEmptyUpdates(canonical)).toBe(true);
  });

  it("treats a template with no interpolation as the string it spells", () => {
    const base = chatPrompt();
    const canonical = canonicalizeUpdates(base, {
      style: "chat",
      system: { kind: "template", value: ["ba", "se"] },
    });
    expect(isEmptyUpdates(canonical)).toBe(true);
  });

  it("ignores display-only detail when comparing, and drops it when storing", () => {
    const base = chatPrompt();
    const withDisplay = canonicalizeUpdates(base, {
      style: "chat",
      system: { ...str("base"), displayValue: "Base" },
    });
    expect(isEmptyUpdates(withDisplay)).toBe(true);

    const changed = canonicalizeUpdates(base, {
      style: "chat",
      system: { ...str("new"), displayValue: "New" },
    });
    expect(changed).toEqual({ style: "chat", system: str("new") });
  });

  it("serializes the same meaning to the same bytes whatever the key order", () => {
    const base = chatPrompt();
    const a = canonicalizeUpdates(base, {
      style: "chat",
      system: str("x"),
      modelParameters: { temperature: num(1), topP: num(0.9) },
    });
    const b = canonicalizeUpdates(base, {
      modelParameters: { topP: num(0.9), temperature: num(1) },
      system: { value: "x", kind: "primitive" },
      style: "chat",
    } as NormalizedPromptUpdates);
    expect(serializeUpdates(a)).toBe(serializeUpdates(b));
  });

  it("keeps null (remove) as a value when the base has the field", () => {
    const base = chatPrompt();
    const canonical = canonicalizeUpdates(base, {
      style: "chat",
      system: null,
    });
    expect(canonical).toEqual({ style: "chat", system: null });
  });

  it("drops removing a field the base doesn't have", () => {
    const base = chatPrompt({ system: undefined });
    expect(
      isEmptyUpdates(
        canonicalizeUpdates(base, { style: "chat", system: null }),
      ),
    ).toBe(true);
  });
});

describe("mergeUpdates", () => {
  it("lets later fields win and merges modelParameters per key", () => {
    const merged = mergeUpdates(
      {
        style: "chat",
        system: str("one"),
        modelParameters: { temperature: num(1), topP: num(0.5) },
      },
      { style: "chat", system: str("two"), modelParameters: { topP: null } },
    );
    expect(merged).toEqual({
      style: "chat",
      system: str("two"),
      modelParameters: { temperature: num(1), topP: null },
    });
  });

  it("keeps null through a merge", () => {
    expect(
      mergeUpdates(
        { style: "chat", system: str("x") },
        { style: "chat", system: null },
      ),
    ).toEqual({ style: "chat", system: null });
  });
});

describe("sameValue", () => {
  it("treats a catalog call and its parsed form as the same call", () => {
    const parsed: PropValue = {
      kind: "functionCall",
      callee: "openai",
      args: [str("gpt-4o")],
      binding: {
        kind: "import",
        name: "openai",
        from: "@ai-sdk/openai",
      } as any,
    };
    const preset: PropValue = {
      kind: "functionCall",
      callee: "openai",
      args: [str("gpt-4o")],
      binding: [
        { kind: "import", name: "openai", from: "@ai-sdk/openai" } as any,
      ],
      displayValue: "GPT-4o",
    };
    expect(sameValue(parsed, preset)).toBe(true);
  });

  it("treats null and absent as the same", () => {
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue([], undefined)).toBe(true);
  });
});
