// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type {
  NormalizedChatPrompt,
  VariationInfo,
  VersionInfo,
} from "../../shared/types";
import {
  effectiveRef,
  fieldText,
  isHeadRef,
  refChipLabel,
  runDisabledReason,
} from "./prompt-ref";

const head: NormalizedChatPrompt = {
  id: "a.prompt.ts#a",
  name: "a",
  style: "chat",
  functionParameters: [],
  modelEditable: true,
  modelParameters: [],
  systemEditable: true,
  messages: [],
  messagesEditable: true,
  ref: { promptId: "a.prompt.ts#a" },
  atHead: true,
};

const commit: VersionInfo = {
  id: "0123456789abcdef",
  kind: "commit",
  message: "Tighten tone",
  time: 0,
};

const wip = (onHead: boolean): VariationInfo => ({
  id: "var_x",
  promptId: head.id,
  base: commit.id,
  updates: { style: "chat" },
  wip: true,
  onHead,
  names: [],
  createdAt: 0,
  updatedAt: 0,
});

describe("effectiveRef", () => {
  it("is the tab's own ref when it names a version or variation", () => {
    const ref = { promptId: head.id, version: commit.id };
    expect(effectiveRef({ ...head, wipId: "var_w" }, ref)).toBe(ref);
  });

  it("is head's unsaved edits when there are some, else head", () => {
    expect(effectiveRef({ ...head, wipId: "var_w" }, undefined)).toEqual({
      promptId: head.id,
      variation: "var_w",
    });
    expect(effectiveRef(head, { promptId: head.id })).toBeUndefined();
    expect(isHeadRef(undefined)).toBe(true);
  });
});

describe("refChipLabel", () => {
  it("labels head, and head with unsaved edits", () => {
    expect(refChipLabel(head)).toBe("Working tree");
    expect(refChipLabel({ ...head, variation: wip(true) })).toBe(
      "Working tree · ● unsaved",
    );
  });

  it("labels an old version with its sha and message", () => {
    expect(
      refChipLabel({
        ...head,
        ref: { promptId: head.id, version: commit.id },
        version: commit,
        atHead: false,
      }),
    ).toBe("0123456 · Tighten tone");
  });

  it("labels a named variation, and where it sits when that isn't head", () => {
    const named = { ...wip(false), wip: false, names: ["terse"] };
    expect(refChipLabel({ ...head, variation: named })).toBe("terse");
    expect(
      refChipLabel({
        ...head,
        variation: named,
        version: commit,
        atHead: false,
      }),
    ).toBe("terse · on 0123456");
  });
});

describe("runDisabledReason", () => {
  it("allows head and refuses an old version or a conflicted WIP", () => {
    expect(runDisabledReason(head)).toBeUndefined();
    expect(runDisabledReason({ ...head, atHead: false })).toMatch(
      /working tree/,
    );
    expect(
      runDisabledReason({
        ...head,
        variation: {
          ...wip(true),
          pending: {
            onto: "v",
            updates: { style: "chat" },
            conflicts: [],
            labels: { target: "a", variation: "b" },
          },
        },
      }),
    ).toMatch(/conflicts/);
  });
});

describe("fieldText", () => {
  it("spells out a message list one message per paragraph", () => {
    expect(
      fieldText([
        { role: "user", content: { kind: "primitive", value: "Hi" } },
        { role: "assistant", content: { kind: "primitive", value: "Hello" } },
      ]),
    ).toBe("user: Hi\n\nassistant: Hello");
    expect(fieldText(undefined)).toBe("");
    expect(
      fieldText({ kind: "primitive", value: "x".repeat(300) }),
    ).toHaveLength(300);
  });
});
