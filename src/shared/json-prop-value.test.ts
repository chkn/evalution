// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { jsonToPropValue, propValueToJson } from "./json-prop-value.ts";

describe("jsonToPropValue", () => {
  it("wraps a primitive as a `primitive` PropValue", () => {
    expect(jsonToPropValue("hi")).toEqual({ kind: "primitive", value: "hi" });
    expect(jsonToPropValue(42)).toEqual({ kind: "primitive", value: 42 });
    expect(jsonToPropValue(true)).toEqual({ kind: "primitive", value: true });
    expect(jsonToPropValue(null)).toEqual({ kind: "primitive", value: null });
  });

  it("converts an array into an `array` PropValue, recursively", () => {
    expect(jsonToPropValue(["a", 1, null])).toEqual({
      kind: "array",
      elements: [
        { kind: "primitive", value: "a" },
        { kind: "primitive", value: 1 },
        { kind: "primitive", value: null },
      ],
    });
  });

  it("converts a plain object into an `object` PropValue, recursively", () => {
    expect(jsonToPropValue({ id: "ws_1", active: true })).toEqual({
      kind: "object",
      properties: {
        id: { kind: "primitive", value: "ws_1" },
        active: { kind: "primitive", value: true },
      },
    });
  });

  it("nests objects and arrays inside one another", () => {
    expect(jsonToPropValue({ tags: ["a", "b"], meta: { n: 1 } })).toEqual({
      kind: "object",
      properties: {
        tags: {
          kind: "array",
          elements: [
            { kind: "primitive", value: "a" },
            { kind: "primitive", value: "b" },
          ],
        },
        meta: {
          kind: "object",
          properties: { n: { kind: "primitive", value: 1 } },
        },
      },
    });
  });
});

describe("propValueToJson", () => {
  it("round-trips plain JSON", () => {
    for (const value of [
      "hi",
      4,
      true,
      null,
      [1, "a"],
      { a: { b: [false] } },
    ]) {
      expect(propValueToJson(jsonToPropValue(value))).toEqual(value);
    }
  });

  it("reads a tuple as an array and an interpolation-free template as a string", () => {
    expect(
      propValueToJson({
        kind: "tuple",
        elements: [{ kind: "primitive", value: 1 }],
      }),
    ).toEqual([1]);
    expect(propValueToJson({ kind: "template", value: ["a", "b"] })).toBe("ab");
  });

  it("is undefined for anything that only means something as source", () => {
    expect(
      propValueToJson({ kind: "template", value: ["Hi ", { expr: "name" }] }),
    ).toBeUndefined();
    expect(
      propValueToJson({
        kind: "object",
        properties: {
          model: { kind: "functionCall", callee: "openai", args: [] },
        },
      }),
    ).toBeUndefined();
    expect(
      propValueToJson({ kind: "reference", path: ["ticket"] }),
    ).toBeUndefined();
  });
});
