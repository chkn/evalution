// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import type {
  DatasetField,
  DatasetRow,
  ExecutionInput,
} from "../../shared/types";
import {
  applyUpdate,
  buildColumns,
  cellEdits,
  cellView,
  clearEdits,
  committedCell,
  type DatasetColumn,
  DEFAULT_LAYOUT,
  editableBase,
  editedCell,
  fieldIdsByGroup,
  fitsEditor,
  groupEdits,
  groupHeader,
  layoutStorageKey,
  parseDatasetLayout,
  RowPager,
  readPath,
  serializeDatasetLayout,
} from "./dataset-grid";

const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

const field = (id: string, name: string, syntax = "string"): DatasetField => ({
  id,
  def: { name, type: { kind: "primitive", syntax } } as DatasetField["def"],
});

const FIELDS = [
  field("0", "ticket"),
  field("1", "task", "Task"),
  field("2", "info", "Info"),
];
const SHAPE = {
  "1": { keys: ["title", "owner"], resource: true },
  "2": { keys: ["title"] },
};

/** A typed-in object value, as a trace's recorded inputs store one. */
const info: ExecutionInput = {
  kind: "value",
  value: {
    kind: "object",
    properties: { title: { kind: "primitive", value: "Say hi" } },
  },
};

const seeded: ExecutionInput = {
  kind: "resource",
  uri: "tasks.ts#seededTask",
  args: { title: text("Milk"), owner: { kind: "resource", uri: "db.ts#db" } },
};
const blank: ExecutionInput = { kind: "resource", uri: "tasks.ts#blank" };

const row = (
  cells: DatasetRow["cells"],
  extra: Partial<DatasetRow> = {},
): DatasetRow => ({ id: "r", cells, createdAt: 1, ...extra });

function columns(expanded: string[] = []) {
  return buildColumns({
    fields: FIELDS,
    shape: SHAPE,
    expanded: new Set(expanded),
    shortType: s => s,
  });
}

const byId = (cols: DatasetColumn[], id: string) => {
  const found = cols.find(c => c.id === id);
  if (!found) throw new Error(`no column ${id}`);
  return found;
};

describe("buildColumns", () => {
  it("shows each field whole, grouping only a field with keys", () => {
    const cols = columns();
    expect(cols.map(c => [c.id, c.title, c.role, c.group])).toEqual([
      ["0", "ticket", "whole", undefined],
      ["1", "task", "whole", "task"],
      ["2", "info", "whole", "info"],
      ["source", "source", "source", undefined],
    ]);
    expect(cols[1].type).toBe("Task");
  });

  it("splits an expanded resource field into its head and one column per key", () => {
    expect(columns(["1"]).map(c => [c.id, c.title, c.role, c.group])).toEqual([
      ["0", "ticket", "whole", undefined],
      ["1/", "task", "head", "task"],
      ["1/title", "title", "key", "task"],
      ["1/owner", "owner", "key", "task"],
      ["2", "info", "whole", "info"],
      ["source", "source", "source", undefined],
    ]);
  });

  it("gives an expanded field of objects no head: it would only read {…}", () => {
    expect(columns(["2"]).map(c => [c.id, c.role])).toEqual([
      ["0", "whole"],
      ["1", "whole"],
      ["2/title", "key"],
      ["source", "source"],
    ]);
  });

  it("ignores an expanded field that has no keys", () => {
    expect(columns(["0"]).map(c => c.id)).toEqual(["0", "1", "2", "source"]);
  });
});

describe("group headers", () => {
  it("marks a group collapsed or expanded, and leaves ungrouped columns bare", () => {
    const byGroup = fieldIdsByGroup(columns(["1"]));
    expect([...byGroup]).toEqual([
      ["task", "1"],
      ["info", "2"],
    ]);

    expect(groupHeader("task", byGroup, new Set(["1"]))).toEqual({
      name: "task",
      icon: "disclosureExpanded",
    });
    expect(groupHeader("info", byGroup, new Set(["1"]))).toEqual({
      name: "info",
      icon: "disclosureCollapsed",
    });
    // The source column and the like: no group, so no triangle.
    expect(groupHeader("", byGroup, new Set())).toEqual({ name: "" });
  });
});

describe("readPath", () => {
  it("reads a whole cell, or absent for a sparse row", () => {
    expect(readPath(row({ "1": seeded }), { fieldId: "1" })).toBe(seeded);
    expect(readPath(row({}), { fieldId: "1" })).toBe("absent");
    expect(readPath(row({}), { fieldId: "1", key: "title" })).toBe("absent");
  });

  it("reads a resource's argument and an object's property by key", () => {
    expect(
      readPath(row({ "1": seeded }), { fieldId: "1", key: "title" }),
    ).toEqual(text("Milk"));
    const object: ExecutionInput = {
      kind: "object",
      properties: { title: text("Eggs") },
    };
    expect(
      readPath(row({ "1": object }), { fieldId: "1", key: "title" }),
    ).toEqual(text("Eggs"));
  });

  it("reads a typed-in object's property, wrapped as the value cell it would be", () => {
    expect(
      readPath(row({ "2": info }), { fieldId: "2", key: "title" }),
    ).toEqual({ kind: "value", value: { kind: "primitive", value: "Say hi" } });
    expect(readPath(row({ "2": info }), { fieldId: "2", key: "nope" })).toBe(
      "n/a",
    );
  });

  it("is n/a when the row's resource takes no such argument", () => {
    expect(readPath(row({ "1": blank }), { fieldId: "1", key: "title" })).toBe(
      "n/a",
    );
    expect(
      readPath(row({ "1": text("plain") }), { fieldId: "1", key: "title" }),
    ).toBe("n/a");
  });
});

describe("cellView", () => {
  it("is loading until the row's page arrives", () => {
    expect(cellView(undefined, columns()[0])).toEqual({ kind: "loading" });
  });

  it("previews a value, an empty cell, and a resource chip with its arguments", () => {
    const cols = columns();
    const r = row({ "0": text("Hi"), "1": seeded });
    // `ticket: string` is typed into in place, so it's an editor's view.
    expect(cellView(r, byId(cols, "0"))).toEqual({
      kind: "edit",
      base: "string",
      value: "Hi",
      text: '"Hi"',
    });
    expect(cellView(row({}), byId(cols, "0"))).toEqual({
      kind: "edit",
      base: "string",
      value: undefined,
      text: "—",
    });
    expect(cellView(row({}), byId(cols, "1"))).toEqual({ kind: "empty" });
    expect(cellView(r, byId(cols, "1"))).toEqual({
      kind: "chip",
      text: '◆ seededTask(title: "Milk", owner: db)',
    });
  });

  it("names just the resource in an expanded head, with arguments in their own columns", () => {
    const cols = columns(["1"]);
    const r = row({ "1": seeded });
    expect(cellView(r, byId(cols, "1/"))).toEqual({
      kind: "chip",
      text: "◆ seededTask",
    });
    expect(cellView(r, byId(cols, "1/title"))).toEqual({
      kind: "text",
      text: '"Milk"',
    });
    expect(cellView(r, byId(cols, "1/owner"))).toEqual({
      kind: "chip",
      text: "◆ db",
    });
    expect(cellView(row({ "1": blank }), byId(cols, "1/title"))).toEqual({
      kind: "n/a",
    });
  });

  it("previews a typed-in object with its values, and splits out its property", () => {
    const cols = columns(["2"]);
    expect(cellView(row({ "2": info }), byId(columns(), "2"))).toEqual({
      kind: "text",
      text: '{ title: "Say hi" }',
    });
    expect(cellView(row({ "2": info }), byId(cols, "2/title"))).toEqual({
      kind: "text",
      text: '"Say hi"',
    });
  });

  it("previews an object on one line", () => {
    const object: ExecutionInput = {
      kind: "object",
      properties: {
        db: { kind: "resource", uri: "db.ts#db" },
        userId: text("u1"),
      },
    };
    expect(cellView(row({ "1": object }), byId(columns(), "1"))).toEqual({
      kind: "text",
      text: '{ db: ◆ db, userId: "u1" }',
    });
  });

  it("links a trace source and dims a playground one", () => {
    const source = byId(columns(), "source");
    expect(
      cellView(
        row(
          {},
          { source: { kind: "trace", traceId: "t", traceProviderId: "p" } },
        ),
        source,
      ),
    ).toEqual({ kind: "text", text: "trace ↗", tone: "link" });
    expect(
      cellView(
        row(
          {},
          { source: { kind: "playground", promptId: "p", providerId: "f" } },
        ),
        source,
      ),
    ).toEqual({ kind: "text", text: "playground", tone: "dim" });
    expect(cellView(row({}), source)).toEqual({ kind: "empty" });
  });
});

describe("editableBase", () => {
  const typed = (base: string) => field("9", base, base);
  const whole = (f: DatasetField) =>
    buildColumns({
      fields: [f],
      shape: {},
      expanded: new Set(),
      shortType: s => s,
    })[0];
  const primitive = (value: string | number | boolean | null) =>
    row({ "9": { kind: "value", value: { kind: "primitive", value } } });

  it("edits an empty cell or a plain primitive of a string, number, or boolean field", () => {
    expect(editableBase(row({}), whole(typed("string")))).toBe("string");
    expect(editableBase(primitive("x"), whole(typed("string")))).toBe("string");
    expect(editableBase(primitive(3), whole(typed("number")))).toBe("number");
    expect(editableBase(primitive(true), whole(typed("boolean")))).toBe(
      "boolean",
    );
    // A recorded `base` wins over the syntax.
    const flag: DatasetField = {
      id: "9",
      def: {
        name: "flag",
        type: { kind: "primitive", syntax: "Flag", base: "boolean" },
      } as DatasetField["def"],
    };
    expect(editableBase(row({}), whole(flag))).toBe("boolean");
  });

  it("leaves anything else read-only", () => {
    // Still loading.
    expect(editableBase(undefined, whole(typed("string")))).toBeUndefined();
    // Not a primitive field.
    expect(editableBase(row({}), whole(typed("Task")))).toBeUndefined();
    // A primitive of the wrong type, or a null.
    expect(editableBase(primitive(3), whole(typed("string")))).toBeUndefined();
    expect(
      editableBase(primitive(null), whole(typed("string"))),
    ).toBeUndefined();
    // A template: the text editor would flatten its interpolations.
    const template = row({
      "9": {
        kind: "value",
        value: { kind: "template", value: ["Hi ", { expr: "name" }] },
      },
    });
    expect(editableBase(template, whole(typed("string")))).toBeUndefined();
    // A resource in a string field.
    expect(
      editableBase(row({ "9": blank }), whole(typed("string"))),
    ).toBeUndefined();
    // Key columns and the source column.
    const cols = columns(["1"]);
    expect(editableBase(row({}), byId(cols, "1/title"))).toBeUndefined();
    expect(editableBase(row({}), byId(cols, "source"))).toBeUndefined();
  });
});

describe("editor values", () => {
  it("saves a value that fits as a typed-in primitive, and empty as a clear", () => {
    expect(editedCell("string", "Hi")).toEqual(text("Hi"));
    expect(editedCell("number", 4.5)).toEqual({
      kind: "value",
      value: { kind: "primitive", value: 4.5 },
    });
    expect(editedCell("boolean", false)).toEqual({
      kind: "value",
      value: { kind: "primitive", value: false },
    });
    expect(editedCell("string", "")).toBeNull();
    expect(editedCell("number", undefined)).toBeNull();
    expect(editedCell("boolean", null)).toBeNull();
  });

  it("refuses a value that doesn't fit the cell's type", () => {
    expect(fitsEditor("number", "3")).toBe(false);
    expect(fitsEditor("number", Number.NaN)).toBe(false);
    expect(fitsEditor("boolean", "true")).toBe(false);
    expect(fitsEditor("string", 3)).toBe(false);
    expect(editedCell("number", "3")).toBeUndefined();
  });
});

describe("committedCell", () => {
  it("commits a typed-in value, and an emptied editor as a clear", () => {
    expect(committedCell({ kind: "primitive", value: "x" })).toEqual(text("x"));
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

describe("grid edits", () => {
  const FLAGS = [
    field("0", "ticket"),
    field("1", "count", "number"),
    field("2", "task", "Task"),
  ];
  const cols = buildColumns({
    fields: FLAGS,
    shape: {},
    expanded: new Set(),
    shortType: s => s,
  });
  const rows = [
    row({ "0": text("a"), "2": blank }, { id: "r0" }),
    row({}, { id: "r1" }),
  ];
  const rowAt = (i: number) => rows[i];

  it("turns a paste over a range into cell edits, skipping cells outside the editable set", () => {
    expect(
      cellEdits(
        [
          { col: 0, row: 0, value: "A" },
          { col: 1, row: 0, value: 7 },
          // Read-only: a resource field, and the source column.
          { col: 2, row: 0, value: "x" },
          { col: 3, row: 0, value: "x" },
          // Doesn't fit a number.
          { col: 1, row: 1, value: "seven" },
          // Emptied: a clear.
          { col: 0, row: 1, value: "" },
          // Not loaded.
          { col: 0, row: 5, value: "x" },
        ],
        cols,
        rowAt,
      ),
    ).toEqual([
      { rowId: "r0", fieldId: "0", cell: text("A") },
      {
        rowId: "r0",
        fieldId: "1",
        cell: { kind: "value", value: { kind: "primitive", value: 7 } },
      },
      { rowId: "r1", fieldId: "0", cell: null },
    ]);
  });

  it("clears the editable cells in a selection that hold something", () => {
    expect(
      clearEdits(
        [
          { x: 0, y: 0, width: 4, height: 2 },
          { x: 0, y: 0, width: 1, height: 1 },
        ],
        cols,
        rowAt,
      ),
    ).toEqual([
      { rowId: "r0", fieldId: "0", cell: null },
      // Twice, from the overlapping range; grouping folds it.
      { rowId: "r0", fieldId: "0", cell: null },
    ]);
  });
});

describe("groupEdits", () => {
  it("sends one update per row, in the order rows were first edited", () => {
    expect(
      groupEdits([
        { rowId: "b", fieldId: "0", cell: text("b0") },
        { rowId: "a", fieldId: "0", cell: text("a0") },
        { rowId: "b", fieldId: "1", cell: null },
        // The same cell again: the last value wins.
        { rowId: "a", fieldId: "0", cell: text("a0 again") },
      ]),
    ).toEqual([
      { rowId: "b", cells: { "0": text("b0"), "1": null } },
      { rowId: "a", cells: { "0": text("a0 again") } },
    ]);
    expect(groupEdits([])).toEqual([]);
  });

  it("applies an update as the server stores it: set, clear, rest untouched", () => {
    const before = row({ "0": text("x"), "1": seeded });
    const after = applyUpdate(before, {
      rowId: "r",
      cells: { "0": null, "2": text("new") },
    });
    expect(after.cells).toEqual({ "1": seeded, "2": text("new") });
    expect(Object.hasOwn(after.cells, "0")).toBe(false);
    // The original is left alone, so it can be put back.
    expect(before.cells["0"]).toEqual(text("x"));
  });
});

describe("RowPager", () => {
  const rowsFrom = (offset: number, limit: number, tag = "") =>
    Array.from({ length: limit }, (_, i) =>
      row({}, { id: `${tag}${offset + i}` }),
    );

  /** A pager whose fetches resolve only when the test says so. */
  function pager(pageSize = 10, maxPages = 20) {
    const pending: {
      offset: number;
      limit: number;
      resolve: (rows: DatasetRow[]) => void;
      reject: (err: Error) => void;
    }[] = [];
    const onLoad = vi.fn();
    const onError = vi.fn();
    const p = new RowPager(
      (offset, limit) =>
        new Promise((resolve, reject) =>
          pending.push({ offset, limit, resolve, reject }),
        ),
      onLoad,
      onError,
      pageSize,
      maxPages,
    );
    return { p, pending, onLoad, onError };
  }

  it("fetches only the pages a range covers, once each", async () => {
    const { p, pending, onLoad } = pager();
    p.ensure(5, 25);
    p.ensure(0, 12); // already in flight
    expect(pending.map(f => [f.offset, f.limit])).toEqual([
      [0, 10],
      [10, 10],
      [20, 10],
    ]);
    expect(p.get(3)).toBeUndefined();

    pending[0].resolve(rowsFrom(0, 10));
    await Promise.resolve();
    expect(p.get(3)?.id).toBe("3");
    expect(onLoad).toHaveBeenCalledWith(0, 10);

    p.ensure(0, 5); // loaded and current
    expect(pending).toHaveLength(3);
  });

  it("keeps serving stale rows after invalidate until the refetch lands", async () => {
    const { p, pending } = pager();
    p.ensure(0, 5);
    pending[0].resolve(rowsFrom(0, 10));
    await Promise.resolve();

    p.invalidate();
    expect(p.get(0)?.id).toBe("0");
    p.ensure(0, 5);
    expect(pending).toHaveLength(2);
    pending[1].resolve(rowsFrom(0, 10, "new-"));
    await Promise.resolve();
    expect(p.get(0)?.id).toBe("new-0");
  });

  it("never lets an older response overwrite a newer one", async () => {
    const { p, pending } = pager();
    p.ensure(0, 5);
    p.invalidate();
    p.ensure(0, 5);
    pending[1].resolve(rowsFrom(0, 10, "new-"));
    await Promise.resolve();
    pending[0].resolve(rowsFrom(0, 10, "old-"));
    await Promise.resolve();
    expect(p.get(0)?.id).toBe("new-0");
  });

  it("reports a failed page and retries it on the next ensure", async () => {
    const { p, pending, onError } = pager();
    p.ensure(0, 5);
    pending[0].reject(new Error("offline"));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(new Error("offline"));
    p.ensure(0, 5);
    expect(pending).toHaveLength(2);
  });

  it("patches loaded rows at once, and undoes the patch", async () => {
    const { p, pending } = pager();
    p.ensure(0, 5);
    pending[0].resolve(rowsFrom(0, 10));
    await Promise.resolve();

    const undo = p.patch([
      { rowId: "2", cells: { "0": text("typed") } },
      // Not loaded: nothing to patch.
      { rowId: "99", cells: { "0": text("elsewhere") } },
    ]);
    expect(p.get(2)?.cells).toEqual({ "0": text("typed") });
    expect(p.get(3)?.cells).toEqual({});

    undo();
    expect(p.get(2)?.cells).toEqual({});
  });

  it("doesn't undo over a row a later fetch replaced", async () => {
    const { p, pending } = pager();
    p.ensure(0, 5);
    pending[0].resolve(rowsFrom(0, 10));
    await Promise.resolve();

    const undo = p.patch([{ rowId: "2", cells: { "0": text("typed") } }]);
    p.invalidate();
    p.ensure(0, 5);
    const fresh = rowsFrom(0, 10);
    fresh[2] = row({ "0": text("from the server") }, { id: "2" });
    pending[1].resolve(fresh);
    await Promise.resolve();

    undo();
    expect(p.get(2)?.cells).toEqual({ "0": text("from the server") });
  });

  it("holds at most maxPages, dropping those farthest from the view", async () => {
    const { p, pending } = pager(10, 2);
    for (const start of [0, 10, 20]) {
      p.ensure(start, start + 5);
      pending.at(-1)?.resolve(rowsFrom(start, 10));
      await Promise.resolve();
    }
    // Scrolled to page 2: page 0 is farthest, so it went.
    expect(p.get(0)).toBeUndefined();
    expect(p.get(10)?.id).toBe("10");
    expect(p.get(20)?.id).toBe("20");

    // Scrolling back refetches it.
    p.ensure(0, 5);
    expect(pending.at(-1)?.offset).toBe(0);
  });
});

describe("dataset layout storage", () => {
  it("keys a layout by provider and dataset", () => {
    expect(layoutStorageKey("local", "tickets")).toBe(
      "dataset-layout:local:tickets",
    );
  });

  it("round-trips expanded fields and widths", () => {
    const layout = {
      expanded: new Set(["1", "2"]),
      widths: { "1/title": 320 },
    };
    expect(
      parseDatasetLayout(JSON.parse(serializeDatasetLayout(layout))),
    ).toEqual(layout);
  });

  it("falls back to the default layout for anything unusable", () => {
    for (const raw of [null, 42, "{}", [], { expanded: "1" }]) {
      expect(parseDatasetLayout(raw)).toEqual(DEFAULT_LAYOUT);
    }
  });

  it("drops entries a hand-edited value might hold", () => {
    expect(
      parseDatasetLayout({
        expanded: ["1", 7, null, "2"],
        widths: { a: 100, b: "wide", c: 0, d: -5, e: Number.NaN },
      }),
    ).toEqual({ expanded: new Set(["1", "2"]), widths: { a: 100 } });
  });
});
