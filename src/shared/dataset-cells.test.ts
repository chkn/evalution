// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { InvalidCellError, parseCell, stripReceipts } from "./dataset-cells.ts";

describe("stripReceipts", () => {
  it("removes receipts inside objects and resource arguments", () => {
    expect(
      stripReceipts({
        kind: "object",
        properties: {
          task: {
            kind: "resource",
            uri: "a#t",
            receipt: 1,
            args: { db: { kind: "resource", uri: "a#db", receipt: 2 } },
          },
        },
      }),
    ).toEqual({
      kind: "object",
      properties: {
        task: {
          kind: "resource",
          uri: "a#t",
          args: { db: { kind: "resource", uri: "a#db" } },
        },
      },
    });
  });
});

describe("parseCell", () => {
  it("accepts the three storable variants and strips receipts", () => {
    const value = { kind: "value", value: { kind: "primitive", value: 1 } };
    expect(parseCell(value)).toEqual(value);
    expect(
      parseCell({
        kind: "object",
        properties: { r: { kind: "resource", uri: "a#r", receipt: "x" } },
      }),
    ).toEqual({
      kind: "object",
      properties: { r: { kind: "resource", uri: "a#r" } },
    });
  });

  it("names where a nested problem is", () => {
    expect(() =>
      parseCell({
        kind: "resource",
        uri: "a#r",
        args: { n: { kind: "dataset", uri: "d#1" } },
      }),
    ).toThrow(
      new InvalidCellError(
        "cell.args.n is a dataset reference; a dataset cell must hold a value, object, or resource",
      ),
    );
  });

  it.each([
    null,
    [],
    "text",
    { kind: "value" },
    { kind: "object", properties: [] },
    { kind: "resource", uri: "" },
    { kind: "resource", uri: "a", args: "x" },
  ])("rejects %j", cell => {
    expect(() => parseCell(cell)).toThrow(InvalidCellError);
  });
});
