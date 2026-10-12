// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import { fieldPath, instancePath } from "../../shared/column-paths";
import type {
  DatasetField,
  DatasetRow,
  ExecutionInput,
} from "../../shared/types";
import {
  addColumn,
  type ColumnLayout,
  reconcileColumns,
  setHidden,
} from "./dataset-columns";
import {
  addedTitle,
  applyUpdate,
  buildColumns,
  canMoveColumn,
  cellEdits,
  cellView,
  clearEdits,
  columnPath,
  type DatasetColumn,
  DEFAULT_LAYOUT,
  editableCell,
  editedCell,
  fieldIdsByGroup,
  fitsEditor,
  groupEdits,
  groupHeader,
  layoutStorageKey,
  layoutWithoutField,
  menuFieldId,
  movedLayout,
  parseDatasetLayout,
  pathLabel,
  RowPager,
  rowLabelText,
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
  "1": { keys: ["title", "owner"] },
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

/** An object grafting a resource instance in beside a typed-in value. */
const seeded: ExecutionInput = {
  kind: "object",
  properties: {
    title: text("Milk"),
    owner: { kind: "instance", name: "db" },
  },
};
const blank: ExecutionInput = { kind: "object", properties: {} };
const task: ExecutionInput = { kind: "instance", name: "root", output: "id" };

const row = (
  cells: DatasetRow["cells"],
  extra: Partial<DatasetRow> = {},
): DatasetRow => ({ id: "r", cells, createdAt: 1, ...extra });

function columns(expanded: string[] = []) {
  return buildColumns({
    fields: FIELDS,
    layout: reconcileColumns(undefined, FIELDS, SHAPE),
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

  it("splits an expanded field into one column per key", () => {
    expect(columns(["1"]).map(c => [c.id, c.title, c.role, c.group])).toEqual([
      ["0", "ticket", "whole", undefined],
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

describe("menuFieldId", () => {
  it("names the field for a field's own columns, and nothing for the rest", () => {
    const cols = columns(["1"]);
    expect(menuFieldId(byId(cols, "0"))).toBe("0");
    // The keys inside an expanded field, and the source, aren't fields.
    expect(menuFieldId(byId(cols, "1/title"))).toBeUndefined();
    expect(menuFieldId(byId(cols, "source"))).toBeUndefined();
    expect(menuFieldId(undefined)).toBeUndefined();
  });
});

describe("cellView", () => {
  it("is loading until the row's page arrives", () => {
    expect(cellView(undefined, columns()[0])).toEqual({ kind: "loading" });
  });

  it("previews a value, an empty cell, and a resource instance as a chip", () => {
    const cols = columns();
    const r = row({ "0": text("Hi"), "1": task });
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
      text: "◆ root.id",
    });
  });

  it("splits an expanded object's keys into their own columns", () => {
    const cols = columns(["1"]);
    const r = row({ "1": seeded });
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
        db: { kind: "instance", name: "db" },
        userId: text("u1"),
      },
    };
    expect(cellView(row({ "1": object }), byId(columns(), "1"))).toEqual({
      kind: "text",
      text: '{ db: ◆ db, userId: "u1" }',
    });
  });

  it("draws a stored inline resource node as unsupported text, not undefined", () => {
    // Rows saved before named instances hold `{ kind: "resource" }` cells,
    // whole and nested; Glide crashes on a text cell with no text.
    const legacy = {
      kind: "resource",
      uri: "db.ts#db",
    } as unknown as ExecutionInput;
    const object: ExecutionInput = {
      kind: "object",
      properties: { db: legacy },
    };
    expect(cellView(row({ "1": legacy }), byId(columns(), "1"))).toEqual({
      kind: "text",
      text: "(unsupported)",
    });
    expect(cellView(row({ "1": object }), byId(columns(), "1"))).toEqual({
      kind: "text",
      text: "{ db: (unsupported) }",
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

describe("editableCell", () => {
  const typed = (base: string) => field("9", base, base);
  const whole = (f: DatasetField) =>
    buildColumns({
      fields: [f],
      layout: reconcileColumns(undefined, [f], {}),
      expanded: new Set(),
      shortType: s => s,
    })[0];
  const primitive = (value: string | number | boolean | null) =>
    row({ "9": { kind: "value", value: { kind: "primitive", value } } });

  it("edits an empty cell or a plain primitive of a string, number, or boolean field", () => {
    expect(editableCell(row({}), whole(typed("string")))).toEqual({
      base: "string",
      fieldId: "9",
    });
    expect(editableCell(primitive("x"), whole(typed("string")))).toEqual({
      base: "string",
      fieldId: "9",
      value: "x",
    });
    expect(editableCell(primitive(3), whole(typed("number")))).toEqual({
      base: "number",
      fieldId: "9",
      value: 3,
    });
    expect(editableCell(primitive(false), whole(typed("boolean")))).toEqual({
      base: "boolean",
      fieldId: "9",
      value: false,
    });
    // A recorded `base` wins over the syntax.
    const flag: DatasetField = {
      id: "9",
      def: {
        name: "flag",
        type: { kind: "primitive", syntax: "Flag", base: "boolean" },
      } as DatasetField["def"],
    };
    expect(editableCell(row({}), whole(flag))?.base).toBe("boolean");
  });

  it("leaves anything else read-only", () => {
    // Still loading.
    expect(editableCell(undefined, whole(typed("string")))).toBeUndefined();
    // Not a primitive field.
    expect(editableCell(row({}), whole(typed("Task")))).toBeUndefined();
    // A primitive of the wrong type, or a null.
    expect(editableCell(primitive(3), whole(typed("string")))).toBeUndefined();
    expect(
      editableCell(primitive(null), whole(typed("string"))),
    ).toBeUndefined();
    // A template: the text editor would flatten its interpolations.
    const template = row({
      "9": {
        kind: "value",
        value: { kind: "template", value: ["Hi ", { expr: "name" }] },
      },
    });
    expect(editableCell(template, whole(typed("string")))).toBeUndefined();
    // A resource in a string field.
    expect(
      editableCell(row({ "9": blank }), whole(typed("string"))),
    ).toBeUndefined();
    // Key columns and the source column.
    const cols = columns(["1"]);
    expect(editableCell(row({}), byId(cols, "1/title"))).toBeUndefined();
    expect(editableCell(row({}), byId(cols, "source"))).toBeUndefined();
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

describe("grid edits", () => {
  const FLAGS = [
    field("0", "ticket"),
    field("1", "count", "number"),
    field("2", "task", "Task"),
  ];
  const cols = buildColumns({
    fields: FLAGS,
    layout: reconcileColumns(undefined, FLAGS, {}),
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

  it("patches loaded rows at once", async () => {
    const { p, pending } = pager();
    p.ensure(0, 5);
    pending[0].resolve(rowsFrom(0, 10));
    await Promise.resolve();

    p.patch([
      { rowId: "2", cells: { "0": text("typed") } },
      // Not loaded: nothing to patch.
      { rowId: "99", cells: { "0": text("elsewhere") } },
    ]);
    expect(p.get(2)?.cells).toEqual({ "0": text("typed") });
    expect(p.get(3)?.cells).toEqual({});
    // The patched page is still current: nothing is refetched.
    p.ensure(0, 5);
    expect(pending).toHaveLength(1);
  });

  it("shows the server's row again after two patches both fail and it reloads", async () => {
    const { p, pending } = pager();
    p.ensure(0, 5);
    pending[0].resolve(rowsFrom(0, 10));
    await Promise.resolve();

    p.patch([{ rowId: "2", cells: { "0": text("A") } }]);
    p.patch([{ rowId: "2", cells: { "1": text("B") } }]);
    expect(p.get(2)?.cells).toEqual({ "0": text("A"), "1": text("B") });

    // Both saves failed: reload from the server.
    p.invalidate();
    p.ensure(0, 5);
    expect(pending).toHaveLength(2);
    pending[1].resolve(rowsFrom(0, 10));
    await Promise.resolve();
    expect(p.get(2)?.cells).toEqual({});
  });

  it("doesn't let a fetch in flight when a row was patched overwrite it", async () => {
    const { p, pending } = pager();
    p.ensure(0, 5);
    pending[0].resolve(rowsFrom(0, 10));
    await Promise.resolve();
    p.invalidate();
    p.ensure(0, 5);
    expect(pending).toHaveLength(2);

    p.patch([{ rowId: "2", cells: { "0": text("typed") } }]);
    // Fetched before the edit reached the server: pre-edit data.
    pending[1].resolve(rowsFrom(0, 10));
    await Promise.resolve();
    expect(p.get(2)?.cells).toEqual({ "0": text("typed") });
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

  it("forgets a deleted field's expansion and column widths, and no one else's", () => {
    const layout = {
      expanded: new Set(["1", "2"]),
      widths: { "0": 100, "1": 200, "1/": 210, "1/title": 220, "10/x": 300 },
    };
    expect(layoutWithoutField(layout, "1")).toEqual({
      expanded: new Set(["2"]),
      widths: { "0": 100, "10/x": 300 },
    });
    // The input is left as it was.
    expect(layout.expanded).toEqual(new Set(["1", "2"]));
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

describe("columns from a layout (§Q.3)", () => {
  const planTask: DatasetRow = row(
    {
      "0": text("t-1"),
      "1": { kind: "instance", name: "seededTask", output: "taskId" },
    },
    {
      id: "p",
      resources: {
        seededTask: {
          uri: "file:///tasks.ts#seededTask",
          args: {
            title: text("Web site"),
            count: {
              kind: "value",
              value: { kind: "primitive", value: 3 },
            },
            note: {
              kind: "value",
              value: { kind: "template", value: ["Hi ", { expr: "x" }] },
            } as ExecutionInput,
          },
        },
      },
    },
  );

  const titled = addColumn(
    reconcileColumns(undefined, FIELDS, SHAPE),
    fieldPath("1", ["title"]),
  );
  const layout = addColumn(
    addColumn(titled, instancePath("seededTask", ["title"])),
    fieldPath("1", ["nested", "deep"]),
  );
  const build = (l: ColumnLayout, expanded: string[] = []) =>
    buildColumns({
      fields: FIELDS,
      layout: l,
      expanded: new Set(expanded),
      shortType: s => s,
    });

  it("lays out added columns after the fields, titled by their last key", () => {
    const cols = build(layout);
    expect(cols.map(c => [c.id, c.title, c.role])).toEqual([
      ["0", "ticket", "whole"],
      ["1", "task", "whole"],
      ["2", "info", "whole"],
      ["source", "source", "source"],
      ["@seededTask/title", "title", "added"],
      ["1/nested/deep", "deep", "added"],
    ]);
  });

  it("leaves hidden columns out, and a field's hidden keys out of its group", () => {
    const hidden = setHidden(
      setHidden(layout, { index: 0 }, true),
      { index: 1, key: "owner" },
      true,
    );
    expect(build(hidden, ["1"]).map(c => c.id)).toEqual([
      "1/title",
      "2",
      "source",
      "@seededTask/title",
      "1/nested/deep",
    ]);
  });

  it("shows a column of an unknown kind as a dimmed placeholder", () => {
    const withFuture = reconcileColumns(
      [{ kind: "evalResults" }, { kind: "path", path: fieldPath("0") }],
      FIELDS,
      SHAPE,
    );
    const [unknown] = build(withFuture);
    expect(unknown).toMatchObject({
      title: "Unknown column",
      type: "evalResults",
      role: "unknown",
    });
    expect(cellView(planTask, unknown)).toEqual({ kind: "unknown" });
    expect(editableCell(planTask, unknown)).toBeUndefined();
    expect(columnPath(unknown)).toBeUndefined();
  });

  it("reads an added column through references", () => {
    const cols = build(layout);
    expect(cellView(planTask, byId(cols, "@seededTask/title"))).toMatchObject({
      kind: "edit",
      base: "string",
      value: "Web site",
    });
    expect(cellView(planTask, byId(cols, "1/nested/deep"))).toEqual({
      kind: "n/a",
    });
  });

  it("names a path for a reader", () => {
    expect(pathLabel(fieldPath("1", ["create_task", "title"]), FIELDS)).toBe(
      "task › create_task › title",
    );
    expect(pathLabel(instancePath("t", ["title"]), FIELDS)).toBe("◆ t › title");
    expect(addedTitle(instancePath("t"), FIELDS)).toBe("t");
    expect(addedTitle(fieldPath("2"), FIELDS)).toBe("info");
  });

  describe("editing through an added column (§Q.4)", () => {
    const added = (p: ReturnType<typeof fieldPath>) =>
      build(addColumn(reconcileColumns(undefined, FIELDS, {}), p)).at(-1);

    it("edits a primitive instance argument reached directly or through a reference", () => {
      const spec = planTask.resources?.seededTask;
      for (const p of [
        instancePath("seededTask", ["title"]),
        fieldPath("1", ["title"]),
      ]) {
        expect(editableCell(planTask, added(p))).toEqual({
          base: "string",
          instance: "seededTask",
          arg: "title",
          spec,
          value: "Web site",
        });
      }
      expect(
        editableCell(planTask, added(instancePath("seededTask", ["count"]))),
      ).toMatchObject({ base: "number", value: 3 });
    });

    it("leaves a template argument, a field's key, and the instance itself read-only", () => {
      for (const p of [
        instancePath("seededTask", ["note"]),
        instancePath("seededTask"),
        instancePath("seededTask", ["missing"]),
      ]) {
        expect(editableCell(planTask, added(p))).toBeUndefined();
      }
      const keyed = build(reconcileColumns(undefined, FIELDS, SHAPE), ["1"]);
      expect(editableCell(planTask, byId(keyed, "1/title"))).toBeUndefined();
    });

    it("sends an argument edit as the whole instance with the argument changed", () => {
      const cols = [added(instancePath("seededTask", ["title"]))].filter(
        c => c !== undefined,
      );
      const edits = cellEdits(
        [{ col: 0, row: 0, value: "Todo app" }],
        cols,
        () => planTask,
      );
      const [update] = groupEdits(edits);
      expect(update.cells).toEqual({});
      expect(update.resources?.seededTask?.args?.title).toEqual(
        text("Todo app"),
      );
      expect(update.resources?.seededTask?.args?.count).toEqual(
        planTask.resources?.seededTask.args?.count,
      );
      expect(applyUpdate(planTask, update).resources?.seededTask).toEqual(
        update.resources?.seededTask,
      );

      // Two arguments of one instance in one batch both land; clearing removes.
      const spec = planTask.resources?.seededTask;
      if (!spec) throw new Error("no spec");
      const [both] = groupEdits([
        {
          rowId: "p",
          instance: "seededTask",
          arg: "title",
          spec,
          cell: text("A"),
        },
        { rowId: "p", instance: "seededTask", arg: "count", spec, cell: null },
      ]);
      expect(both.resources?.seededTask?.args).toEqual({
        title: text("A"),
        note: spec.args?.note,
      });
    });
  });
});

describe("moving columns in the grid (§Q.3)", () => {
  const layout = reconcileColumns(undefined, FIELDS, SHAPE);
  // ticket | task/title task/owner | info | source
  const cols = buildColumns({
    fields: FIELDS,
    layout,
    expanded: new Set(["1"]),
    shortType: s => s,
  });

  it("lets a key move only within its own group", () => {
    expect(canMoveColumn(cols, 1, 2)).toBe(true);
    expect(canMoveColumn(cols, 1, 0)).toBe(false);
    expect(canMoveColumn(cols, 2, 3)).toBe(false);
  });

  it("keeps any other column out of an expanded group", () => {
    expect(canMoveColumn(cols, 0, 1)).toBe(false);
    expect(canMoveColumn(cols, 0, 2)).toBe(true);
    expect(canMoveColumn(cols, 4, 2)).toBe(false);
    expect(canMoveColumn(cols, 4, 1)).toBe(true);
    expect(canMoveColumn(cols, 4, 0)).toBe(true);
  });

  it("writes a top-level move to the layout, hidden columns staying put", () => {
    const moved = movedLayout(layout, cols, 4, 0);
    expect(moved.map(c => c.kind)).toEqual([
      "source",
      "field",
      "field",
      "field",
    ]);
    const hidden = setHidden(layout, { index: 2 }, true);
    const shown = buildColumns({
      fields: FIELDS,
      layout: hidden,
      expanded: new Set(),
      shortType: s => s,
    });
    // ticket | task | source  → source first; info, hidden, keeps its place.
    expect(
      movedLayout(hidden, shown, 2, 0).map(c =>
        c.kind === "field" ? c.fieldId : c.kind,
      ),
    ).toEqual(["source", "0", "2", "1"]);
  });

  it("writes a key move to its field's keys", () => {
    const moved = movedLayout(layout, cols, 2, 1)[1];
    expect(moved.kind === "field" && moved.keys.map(k => k.key)).toEqual([
      "owner",
      "title",
    ]);
    expect(movedLayout(layout, cols, 1, 0)).toBe(layout);
  });
});

describe("rowLabelText", () => {
  const r = row(
    { "0": text("Web site"), "1": text(""), "2": info },
    { resources: { t: { uri: "u", args: { n: text("Todo") } } } },
  );
  it("names a row by the label's value, a string unquoted", () => {
    expect(rowLabelText(r, fieldPath("0"))).toBe("Web site");
    expect(rowLabelText(r, instancePath("t", ["n"]))).toBe("Todo");
    expect(rowLabelText(r, fieldPath("2", ["title"]))).toBe("Say hi");
  });
  it("names it by nothing when there's nothing there", () => {
    expect(rowLabelText(r, fieldPath("1"))).toBeUndefined();
    expect(rowLabelText(r, fieldPath("9"))).toBeUndefined();
    expect(rowLabelText(r, fieldPath("0", ["x"]))).toBeUndefined();
  });
});
