// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { canEdit, isNonEmptyStringArray } from "./helpers.ts";

describe("canEdit", () => {
  const primitive = { kind: "primitive", value: "hi" } as const;
  const raw = { kind: "raw", sourceText: "buildSystem()" } as const;

  it("offers an empty or well-shaped slot the SDK supports", () => {
    expect(canEdit(true, undefined)).toBe(true);
    expect(canEdit(true, primitive)).toBe(true);
  });

  it("keeps a capability-true slot holding a raw value read-only", () => {
    expect(canEdit(true, raw)).toBe(false);
  });

  it("keeps a slot the SDK doesn't support read-only, whatever it holds", () => {
    expect(canEdit(false, undefined)).toBe(false);
    expect(canEdit(false, primitive)).toBe(false);
  });

  it("treats a call with no known binding as not editable", () => {
    expect(
      canEdit(true, { kind: "functionCall", callee: "helper", args: [] }),
    ).toBe(false);
  });
});

describe("isNonEmptyStringArray", () => {
  it("accepts a list of strings, refusing an empty one, a mixed one, or a non-list", () => {
    expect(isNonEmptyStringArray(["a", "b"])).toBe(true);
    for (const value of [[], ["a", 2], "a", undefined, { 0: "a" }]) {
      expect(isNonEmptyStringArray(value)).toBe(false);
    }
  });
});
