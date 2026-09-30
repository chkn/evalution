// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  isPrimitiveFieldType,
  matchKey,
  portableDef,
  samePrompt,
} from "./dataset-fields.ts";
import type { PropDefinition } from "./types.ts";

const def = (name: string, syntax: string): PropDefinition => ({
  name,
  optional: false,
  type: { kind: "primitive", syntax },
});

describe("matchKey", () => {
  it("is equal only for the same name and syntax", () => {
    expect(matchKey(def("a", "string"))).toBe(matchKey(def("a", "string")));
    expect(matchKey(def("a", "string"))).not.toBe(matchKey(def("a", "number")));
    expect(matchKey(def("a", "string"))).not.toBe(matchKey(def("b", "string")));
  });
});

describe("portableDef", () => {
  it("drops the source spans and keeps the rest", () => {
    const spanned = {
      ...def("a", "string"),
      valueSpan: { start: 1, end: 2 },
      fullSpan: { start: 0, end: 3 },
    } as PropDefinition;
    expect(portableDef(spanned)).toEqual(def("a", "string"));
  });
});

describe("samePrompt", () => {
  it("compares id and provider, and is false when either is missing", () => {
    expect(
      samePrompt({ id: "p", providerId: "f" }, { id: "p", providerId: "f" }),
    ).toBe(true);
    expect(
      samePrompt({ id: "p", providerId: "f" }, { id: "p", providerId: "g" }),
    ).toBe(false);
    expect(samePrompt({ id: "p" }, { id: "p" })).toBe(true);
    expect(samePrompt({ id: "p" }, undefined)).toBe(false);
    expect(samePrompt(undefined, undefined)).toBe(false);
  });
});

describe("isPrimitiveFieldType", () => {
  it("accepts only string, number and boolean", () => {
    expect(["string", "number", "boolean"].every(isPrimitiveFieldType)).toBe(
      true,
    );
    expect(isPrimitiveFieldType("Date")).toBe(false);
    expect(isPrimitiveFieldType(1)).toBe(false);
  });
});
