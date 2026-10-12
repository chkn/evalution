// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  type DatasetColumnSpec,
  fieldPath,
  instancePath,
} from "../../shared/column-paths";
import type { DatasetField } from "../../shared/types";
import {
  addColumn,
  type ColumnLayout,
  findPath,
  isHidden,
  moveColumn,
  moveKey,
  reconcileColumns,
  removeColumn,
  reorderVisible,
  serializeColumns,
  setHidden,
} from "./dataset-columns";

const field = (id: string, name: string): DatasetField =>
  ({
    id,
    def: { name, type: { kind: "primitive", syntax: "string" } },
  }) as DatasetField;

const FIELDS = [field("0", "ticket"), field("1", "task"), field("2", "info")];
const SHAPE = { "1": { keys: ["title", "owner"] } };

const path = (
  p: ReturnType<typeof fieldPath>,
  extra: Partial<Extract<DatasetColumnSpec, { kind: "path" }>> = {},
): DatasetColumnSpec => ({ kind: "path", path: p, ...extra });

/** Today's layout: every field in schema order, keys shown, then the source. */
const DEFAULT: ColumnLayout = [
  { kind: "field", fieldId: "0", hidden: false, keys: [] },
  {
    kind: "field",
    fieldId: "1",
    hidden: false,
    keys: [
      { key: "title", hidden: false },
      { key: "owner", hidden: false },
    ],
  },
  { kind: "field", fieldId: "2", hidden: false, keys: [] },
  { kind: "source", hidden: false },
];

describe("reconcileColumns", () => {
  it("gives a dataset with no stored columns today's layout", () => {
    expect(reconcileColumns(undefined, FIELDS, SHAPE)).toEqual(DEFAULT);
    expect(reconcileColumns([], FIELDS, SHAPE)).toEqual(DEFAULT);
  });

  it("keeps the stored order and hidden flags", () => {
    const stored = [
      { kind: "source" as const },
      path(fieldPath("2"), { hidden: true }),
      path(fieldPath("1")),
      path(fieldPath("1", ["owner"]), { hidden: true }),
      path(fieldPath("1", ["title"])),
      path(fieldPath("0")),
    ];
    expect(reconcileColumns(stored, FIELDS, SHAPE)).toEqual([
      { kind: "source", hidden: false },
      { kind: "field", fieldId: "2", hidden: true, keys: [] },
      {
        kind: "field",
        fieldId: "1",
        hidden: false,
        keys: [
          { key: "owner", hidden: true },
          { key: "title", hidden: false },
        ],
      },
      { kind: "field", fieldId: "0", hidden: false, keys: [] },
    ]);
  });

  it("drops a field that no longer exists, and any column rooted at it", () => {
    const stored = [
      path(fieldPath("9")),
      path(fieldPath("9", ["x", "y"]), { added: true }),
      ...serializeColumns(DEFAULT),
    ];
    expect(reconcileColumns(stored, FIELDS, SHAPE)).toEqual(DEFAULT);
  });

  it("appends a new field at the end, and a new key at the end of its field", () => {
    const stored = [
      path(fieldPath("1")),
      path(fieldPath("1", ["owner"])),
      { kind: "source" as const },
      path(fieldPath("0")),
    ];
    expect(reconcileColumns(stored, FIELDS, SHAPE)).toEqual([
      {
        kind: "field",
        fieldId: "1",
        hidden: false,
        keys: [
          { key: "owner", hidden: false },
          { key: "title", hidden: false },
        ],
      },
      { kind: "source", hidden: false },
      { kind: "field", fieldId: "0", hidden: false, keys: [] },
      { kind: "field", fieldId: "2", hidden: false, keys: [] },
    ]);
  });

  it("drops a key no row holds any more, but keeps an added path", () => {
    const deep = fieldPath("1", ["gone", "deeper"]);
    const stored = [
      path(fieldPath("1", ["gone"])),
      path(fieldPath("2", ["note"]), { added: true }),
      path(deep, { added: true, title: "Deep" }),
    ];
    const layout = reconcileColumns(stored, FIELDS, SHAPE);
    expect(layout.filter(c => c.kind === "added")).toEqual([
      { kind: "added", path: fieldPath("2", ["note"]), hidden: false },
      { kind: "added", path: deep, hidden: false, title: "Deep" },
    ]);
    expect(findPath(layout, fieldPath("1", ["gone"]))).toBeUndefined();
  });

  it("keeps the first of a repeated path", () => {
    const stored = [
      path(fieldPath("0"), { hidden: true }),
      path(fieldPath("0")),
      path(instancePath("t", ["title"]), { added: true }),
      path(instancePath("t", ["title"]), { added: true, hidden: true }),
      { kind: "source" as const, hidden: true as const },
      { kind: "source" as const },
    ];
    const layout = reconcileColumns(stored, FIELDS, SHAPE);
    expect(layout.slice(0, 3)).toEqual([
      { kind: "field", fieldId: "0", hidden: true, keys: [] },
      { kind: "added", path: instancePath("t", ["title"]), hidden: false },
      { kind: "source", hidden: true },
    ]);
    expect(layout).toHaveLength(5);
  });

  it("treats an added path the rows now derive as the field's own key", () => {
    const stored = [path(fieldPath("1", ["owner"]), { added: true })];
    expect(reconcileColumns(stored, FIELDS, SHAPE)[0]).toEqual({
      kind: "field",
      fieldId: "1",
      hidden: false,
      keys: [
        { key: "owner", hidden: false },
        { key: "title", hidden: false },
      ],
    });
  });

  it("keeps a column of an unknown kind in its place, and writes it back intact", () => {
    const future = { kind: "evalResults", run: "r1", hidden: true as const };
    const stored = [path(fieldPath("0")), future, path(fieldPath("2"))];
    const layout = reconcileColumns(stored, FIELDS, SHAPE);
    expect(layout[1]).toEqual({ kind: "unknown", spec: future, hidden: true });
    const shown = setHidden(layout, { index: 1 }, false);
    expect(serializeColumns(shown)[1]).toEqual({
      kind: "evalResults",
      run: "r1",
    });
    expect(serializeColumns(layout)[1]).toEqual(future);
  });
});

describe("serializeColumns", () => {
  it("round-trips through reconcileColumns", () => {
    const layout = addColumn(
      setHidden(DEFAULT, { index: 1, key: "owner" }, true),
      instancePath("seededTask", ["title"]),
    );
    const stored = serializeColumns(layout);
    expect(stored).toContainEqual({
      kind: "path",
      path: instancePath("seededTask", ["title"]),
      added: true,
    });
    expect(reconcileColumns(stored, FIELDS, SHAPE)).toEqual(layout);
  });
});

describe("layout edits", () => {
  it("hides a field with its keys, or a key on its own", () => {
    const hidden = setHidden(DEFAULT, { index: 1 }, true);
    expect(isHidden(hidden, { index: 1 })).toBe(true);
    expect(isHidden(hidden, { index: 1, key: "title" })).toBe(true);
    const key = setHidden(DEFAULT, { index: 1, key: "title" }, true);
    expect(isHidden(key, { index: 1 })).toBe(false);
    expect(isHidden(key, { index: 1, key: "title" })).toBe(true);
    expect(isHidden(key, { index: 1, key: "owner" })).toBe(false);
  });

  it("moves top-level columns, and keys only within their field", () => {
    expect(moveColumn(DEFAULT, 3, 0).map(c => c.kind)).toEqual([
      "source",
      "field",
      "field",
      "field",
    ]);
    const keys = moveKey(DEFAULT, 1, 1, 0)[1];
    expect(keys.kind === "field" && keys.keys.map(k => k.key)).toEqual([
      "owner",
      "title",
    ]);
  });

  it("removes only added columns", () => {
    const added = addColumn(DEFAULT, instancePath("t", ["title"]));
    expect(removeColumn(added, 4)).toEqual(DEFAULT);
    expect(removeColumn(DEFAULT, 0)).toBe(DEFAULT);
    expect(removeColumn(DEFAULT, 3)).toBe(DEFAULT);
  });

  it("shows a path that already has a column rather than adding it twice", () => {
    const hidden = setHidden(
      setHidden(DEFAULT, { index: 1 }, true),
      { index: 1, key: "owner" },
      true,
    );
    const shown = addColumn(hidden, fieldPath("1", ["owner"]));
    expect(shown).toHaveLength(DEFAULT.length);
    expect(isHidden(shown, { index: 1, key: "owner" })).toBe(false);
  });
});

describe("reorderVisible", () => {
  it("rearranges the visible items, leaving hidden ones in place", () => {
    const list = ["a", "(b)", "c", "(d)", "e"];
    expect(
      reorderVisible(list, x => !x.startsWith("("), ["e", "a", "c"]),
    ).toEqual(["e", "(b)", "a", "(d)", "c"]);
  });
});
