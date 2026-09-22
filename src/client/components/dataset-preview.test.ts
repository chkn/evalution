// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  previewCell,
  previewPropValue,
  propValueToJson,
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

  it("collapses an object cell nested in a preview", () => {
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
  });
});

describe("resourceName", () => {
  it("falls back to the whole uri without a #", () => {
    expect(resourceName("plain")).toBe("plain");
  });
});

describe("propValueToJson", () => {
  it("spells literals, templates, objects and arrays as plain data", () => {
    expect(
      propValueToJson({
        kind: "object",
        properties: {
          n: { kind: "primitive", value: 1 },
          missing: { kind: "primitive", value: undefined },
          note: { kind: "template", value: ["Hi ", { expr: "name" }] },
          tags: {
            kind: "array",
            elements: [{ kind: "primitive", value: "a" }],
          },
        },
      }),
    ).toEqual({ n: 1, missing: null, note: "Hi ${name}", tags: ["a"] });
  });

  it("previews what isn't data", () => {
    expect(propValueToJson({ kind: "reference", path: ["ticket", "id"] })).toBe(
      "ticket.id",
    );
  });
});
