// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  committedCell,
  fitsPrimitiveBase,
  InvalidCellError,
  parseCell,
  parseResources,
  primitiveBase,
  stripReceipts,
} from "./dataset-cells.ts";

describe("stripReceipts", () => {
  it("removes each instance's receipt, keeping its arguments", () => {
    const args = {
      parentId: { kind: "instance" as const, name: "root", output: "id" },
    };
    expect(
      stripReceipts({
        root: { uri: "a#t", receipt: 1 },
        child: { uri: "a#t", args, receipt: 2 },
      }),
    ).toEqual({ root: { uri: "a#t" }, child: { uri: "a#t", args } });
  });
});

describe("parseCell", () => {
  it("accepts the storable variants", () => {
    const value = { kind: "value", value: { kind: "primitive", value: 1 } };
    expect(parseCell(value)).toEqual(value);
    const object = {
      kind: "object",
      properties: { r: { kind: "instance", name: "db", output: "url" } },
    };
    expect(parseCell(object)).toEqual(object);
  });

  it("names where a nested problem is", () => {
    expect(() =>
      parseCell({
        kind: "object",
        properties: { n: { kind: "dataset", field: "1" } },
      }),
    ).toThrow(
      new InvalidCellError(
        "cell.properties.n is a column reference; a dataset cell must hold a value, object, resource, or slot reference",
      ),
    );
  });

  it("keeps a slot reference as-is", () => {
    const cell = { kind: "input", half: "execute", path: "ctx.db" };
    expect(parseCell(cell)).toEqual(cell);
  });

  it.each([
    null,
    [],
    "text",
    { kind: "value" },
    { kind: "object", properties: [] },
    { kind: "instance", name: "" },
    { kind: "instance", name: "a", output: 1 },
    { kind: "resource", uri: "a#r" },
    { kind: "input", half: "other", path: "x" },
    { kind: "input", half: "function", path: "" },
  ])("rejects %j", cell => {
    expect(() => parseCell(cell)).toThrow(InvalidCellError);
  });
});

describe("parseResources", () => {
  it("accepts named instances, stripping receipts", () => {
    expect(
      parseResources({
        db: { uri: "a#db", receipt: "r" },
        task: {
          uri: "a#task",
          args: {
            db: { kind: "instance", name: "db" },
            title: { kind: "value", value: { kind: "primitive", value: "T" } },
          },
        },
      }),
    ).toEqual({
      db: { uri: "a#db" },
      task: {
        uri: "a#task",
        args: {
          db: { kind: "instance", name: "db" },
          title: { kind: "value", value: { kind: "primitive", value: "T" } },
        },
      },
    });
  });

  it("lets arguments name a column only when asked to", () => {
    const resources = {
      task: { uri: "a#task", args: { title: { kind: "dataset", field: "0" } } },
    };
    expect(() => parseResources(resources)).toThrow(
      /resources\.task\.args\.title is a column reference/,
    );
    expect(parseResources(resources, { columns: true })).toEqual(resources);
  });

  it.each([
    [null, /resources must be an object/],
    [{ "1st": { uri: "a#t" } }, /resources\.1st: a resource name/],
    [{ t: "a#t" }, /resources\.t must be an object/],
    [{ t: { uri: "" } }, /resources\.t\.uri must be a non-empty string/],
    [{ t: { uri: "a#t", args: [] } }, /resources\.t\.args must be an object/],
  ])("rejects %j", (value, message) => {
    expect(() => parseResources(value)).toThrow(message);
  });
});

describe("primitiveBase", () => {
  it("reads a recorded base, or a bare primitive's syntax", () => {
    expect(
      primitiveBase({ kind: "primitive", syntax: "string", base: "string" }),
    ).toBe("string");
    expect(primitiveBase({ kind: "primitive", syntax: "number" })).toBe(
      "number",
    );
    expect(
      primitiveBase({ kind: "primitive", syntax: "Flag", base: "boolean" }),
    ).toBe("boolean");
  });

  it("is undefined for any other type", () => {
    expect(primitiveBase({ kind: "primitive", syntax: "Db" })).toBeUndefined();
    expect(
      primitiveBase({ kind: "primitive", syntax: "bigint", base: "bigint" }),
    ).toBeUndefined();
    expect(
      primitiveBase({ kind: "object", syntax: "{}", properties: [] }),
    ).toBeUndefined();
  });
});

describe("fitsPrimitiveBase", () => {
  it("takes a primitive of the base, and a template for a string", () => {
    expect(fitsPrimitiveBase({ kind: "primitive", value: "x" }, "string")).toBe(
      true,
    );
    expect(fitsPrimitiveBase({ kind: "primitive", value: 3 }, "number")).toBe(
      true,
    );
    expect(
      fitsPrimitiveBase({ kind: "primitive", value: false }, "boolean"),
    ).toBe(true);
    expect(
      fitsPrimitiveBase(
        { kind: "template", value: ["Hi ", { expr: "n" }] },
        "string",
      ),
    ).toBe(true);
  });

  it("refuses anything else", () => {
    expect(fitsPrimitiveBase({ kind: "primitive", value: "3" }, "number")).toBe(
      false,
    );
    expect(
      fitsPrimitiveBase({ kind: "primitive", value: null }, "string"),
    ).toBe(false);
    expect(fitsPrimitiveBase({ kind: "template", value: [] }, "number")).toBe(
      false,
    );
    expect(
      fitsPrimitiveBase({ kind: "object", properties: {} }, "string"),
    ).toBe(false);
  });
});

describe("committedCell", () => {
  it("commits a typed-in value, and an emptied editor as a clear", () => {
    expect(committedCell({ kind: "primitive", value: "x" })).toEqual({
      kind: "value",
      value: { kind: "primitive", value: "x" },
    });
    const template = {
      kind: "template" as const,
      value: ["Hi ", { expr: "name" }],
    };
    expect(committedCell(template)).toEqual({ kind: "value", value: template });
    expect(committedCell({ kind: "primitive", value: "" })).toBeNull();
    expect(committedCell({ kind: "primitive", value: undefined })).toBeNull();
    // `false` and `0` are values, not empties.
    expect(committedCell({ kind: "primitive", value: 0 })).toEqual({
      kind: "value",
      value: { kind: "primitive", value: 0 },
    });
  });
});
