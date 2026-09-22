// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  objectCellLines,
  previewCell,
  previewPropValue,
  resourceName,
} from "./dataset-preview";

describe("previewPropValue", () => {
  it("quotes strings and shows other primitives plainly", () => {
    expect(previewPropValue({ kind: "primitive", value: "hi" })).toBe('"hi"');
    expect(previewPropValue({ kind: "primitive", value: true })).toBe("true");
    expect(previewPropValue({ kind: "primitive", value: undefined })).toBe("—");
  });

  it("shows a template's text, interpolations included", () => {
    expect(
      previewPropValue({
        kind: "template",
        value: ["Order ", { expr: "id" }, " late"],
      }),
    ).toBe('"Order ${id} late"');
  });
});

describe("previewCell", () => {
  it("names a resource by its export, with an arguments summary", () => {
    expect(
      previewCell({
        kind: "resource",
        uri: ".evalution/playground/tasks.ts#seededTask",
        args: {
          title: { kind: "value", value: { kind: "primitive", value: "Milk" } },
          owner: { kind: "resource", uri: "db.ts#db" },
        },
      }),
    ).toBe('seededTask(title: "Milk", owner: db)');
  });

  it("truncates a long value", () => {
    const preview = previewCell({
      kind: "value",
      value: { kind: "primitive", value: "x".repeat(200) },
    });
    expect(preview.length).toBe(60);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("collapses an object cell, which expands line by line", () => {
    const cell = {
      kind: "object" as const,
      properties: {
        db: { kind: "resource" as const, uri: "db.ts#db" },
        userId: {
          kind: "value" as const,
          value: { kind: "primitive" as const, value: "u1" },
        },
      },
    };
    expect(previewCell(cell)).toBe("{…}");
    expect(objectCellLines(cell)).toEqual([
      { key: "db", preview: "db" },
      { key: "userId", preview: '"u1"' },
    ]);
  });
});

describe("resourceName", () => {
  it("falls back to the whole uri without a #", () => {
    expect(resourceName("plain")).toBe("plain");
  });
});
