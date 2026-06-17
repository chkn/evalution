// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { consumeSelfEdit, markSelfEdit } from "./self-edits.ts";

describe("self-edits", () => {
  it("consumes a marked edit exactly once", () => {
    markSelfEdit("change", "fs", "a.prompt.ts#one");
    expect(consumeSelfEdit("change", "fs", "a.prompt.ts#one")).toBe(true);
    expect(consumeSelfEdit("change", "fs", "a.prompt.ts#one")).toBe(false);
  });

  it("does not match a different prompt, provider, or event type", () => {
    markSelfEdit("change", "fs", "a.prompt.ts#one");
    expect(consumeSelfEdit("change", "fs", "a.prompt.ts#two")).toBe(false);
    expect(consumeSelfEdit("add", "fs", "a.prompt.ts#one")).toBe(false);
    expect(consumeSelfEdit("change", "other", "a.prompt.ts#one")).toBe(false);
    // The original mark is still pending and can be consumed.
    expect(consumeSelfEdit("change", "fs", "a.prompt.ts#one")).toBe(true);
  });

  it("queues multiple rapid edits to the same prompt", () => {
    markSelfEdit("change", "fs", "b.prompt.ts#x");
    markSelfEdit("change", "fs", "b.prompt.ts#x");
    expect(consumeSelfEdit("change", "fs", "b.prompt.ts#x")).toBe(true);
    expect(consumeSelfEdit("change", "fs", "b.prompt.ts#x")).toBe(true);
    expect(consumeSelfEdit("change", "fs", "b.prompt.ts#x")).toBe(false);
  });

  it("returns false for edits that never happened", () => {
    expect(consumeSelfEdit("change", "fs", "never.prompt.ts#nope")).toBe(false);
  });
});
