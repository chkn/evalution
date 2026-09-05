// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { PropDefinition } from "../shared/types";
import { defaultValueForType, withSetMembership } from "./utils";

type PropType = PropDefinition["type"];

describe("defaultValueForType", () => {
  it("returns 0 for number primitives", () => {
    const type: PropType = { kind: "primitive", syntax: "number" };
    expect(defaultValueForType(type)).toEqual({ kind: "primitive", value: 0 });
  });

  it("returns false for boolean primitives", () => {
    const type: PropType = { kind: "primitive", syntax: "boolean" };
    expect(defaultValueForType(type)).toEqual({
      kind: "primitive",
      value: false,
    });
  });

  it("returns empty string for string primitives", () => {
    const type: PropType = { kind: "primitive", syntax: "string" };
    expect(defaultValueForType(type)).toEqual({ kind: "primitive", value: "" });
  });

  it("returns empty array for array types", () => {
    const type: PropType = {
      kind: "array",
      syntax: "string[]",
      elementType: { kind: "primitive", syntax: "string" },
    };
    expect(defaultValueForType(type)).toEqual({ kind: "array", elements: [] });
  });

  it("returns the first constant value from a union", () => {
    const type: PropType = {
      kind: "union",
      syntax: '"low" | "medium" | "high"',
      types: [
        { kind: "constant", syntax: '"low"', value: "low" },
        { kind: "constant", syntax: '"medium"', value: "medium" },
      ],
    };
    expect(defaultValueForType(type)).toEqual({
      kind: "primitive",
      value: "low",
    });
  });

  it("seeds the open-ended member of a nullable union, not the null", () => {
    const type: PropType = {
      kind: "union",
      syntax: "string | null",
      types: [
        { kind: "primitive", syntax: "string" },
        { kind: "constant", syntax: "null", value: null },
      ],
    };
    expect(defaultValueForType(type)).toEqual({ kind: "primitive", value: "" });
  });

  it("seeds the first open-ended member, skipping leading constants", () => {
    const type: PropType = {
      kind: "union",
      syntax: "'auto' | 'none' | number",
      types: [
        { kind: "constant", syntax: "'auto'", value: "auto" },
        { kind: "constant", syntax: "'none'", value: "none" },
        { kind: "primitive", syntax: "number" },
      ],
    };
    expect(defaultValueForType(type)).toEqual({ kind: "primitive", value: 0 });
  });

  it("seeds the first member of a union with no constants", () => {
    const type: PropType = {
      kind: "union",
      syntax: "number | string",
      types: [
        { kind: "primitive", syntax: "number" },
        { kind: "primitive", syntax: "string" },
      ],
    };
    expect(defaultValueForType(type)).toEqual({ kind: "primitive", value: 0 });
  });
});

describe("withSetMembership", () => {
  it("adds a value that should be present but isn't", () => {
    const set = new Set(["a"]);
    const next = withSetMembership(set, "b", true);
    expect(next).not.toBe(set);
    expect([...next].sort()).toEqual(["a", "b"]);
  });

  it("removes a value that shouldn't be present but is", () => {
    const set = new Set(["a", "b"]);
    const next = withSetMembership(set, "b", false);
    expect(next).not.toBe(set);
    expect([...next]).toEqual(["a"]);
  });

  it("returns the same reference when membership already matches (present)", () => {
    const set = new Set(["a"]);
    expect(withSetMembership(set, "a", true)).toBe(set);
  });

  it("returns the same reference when membership already matches (absent)", () => {
    const set = new Set(["a"]);
    expect(withSetMembership(set, "b", false)).toBe(set);
  });
});
