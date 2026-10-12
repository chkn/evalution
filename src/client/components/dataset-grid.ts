// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The dataset table's model, apart from the grid that draws it: which columns
 * it has, what each cell shows, and the paged cache rows are read through.
 * Pure and grid-agnostic — `DatasetView` maps it onto Glide Data Grid.
 *
 * A column is a {@link ColumnPath} into a row: a whole field, one key inside
 * it — an object's property, or a property of a typed-in object value — or
 * any other path a column was added at. A field's keys come from
 * {@link DatasetRowsOverview}, found in the rows rather than the schema, and
 * merged by name. Which columns show, and in what order, is the dataset's
 * shared {@link ColumnLayout}. A path is also what sorting and filtering will
 * name when they arrive.
 *
 * Some cells are typed into in place — see {@link editableCell}. An edit is
 * reported per cell and sent per row ({@link groupEdits}), and the page it
 * lands on is patched at once ({@link RowPager.patch}), before the server
 * answers.
 */

import {
  type ColumnPath,
  columnPathId,
  fieldPath,
  pathField,
  readColumnPath,
  resolveColumnPath,
} from "../../shared/column-paths";
import {
  committedCell,
  type EditableBase,
  primitiveBase,
} from "../../shared/dataset-cells";
import type {
  DatasetField,
  DatasetRow,
  DatasetRowsOverview,
  DatasetRowUpdate,
  ExecutionInput,
  PropValue,
  ResourceInstanceInput,
} from "../../shared/types";
import {
  type ColumnLayout,
  type LayoutSlot,
  reorderVisible,
} from "./dataset-columns";
import { previewCell, previewPropValue } from "./dataset-preview";
import { DISCLOSURE_COLLAPSED, DISCLOSURE_EXPANDED } from "./grid-sprites";

/** One column of the dataset table. */
export type DatasetColumn = {
  /**
   * Stable across layouts — resized widths are remembered by it. A path's
   * column is keyed by its serialized path ({@link columnPathId}).
   */
  id: string;
  title: string;
  /** Shown after the title, dimmed — the field's type, shortened. */
  type?: string;
  /**
   * The group header this column sits under: the field's name, for a field
   * whose cells have keys to expand into. See {@link fieldGroup}.
   */
  group?: string;
  width: number;
  /**
   * For a field's whole column, the primitive type its cells can be typed in
   * as — see {@link editableCell}. Absent for any other column.
   */
  base?: EditableBase;
  /** Where the column sits in the {@link ColumnLayout} it was built from. */
  slot: LayoutSlot;
} & (
  | {
      /** A field in one column. */
      role: "whole";
      path: ColumnPath;
    }
  /** One key inside a field. */
  | { role: "key"; path: ColumnPath }
  /** A column added from the picker, at any other path. */
  | { role: "added"; path: ColumnPath }
  /** Where the row came from. */
  | { role: "source" }
  /**
   * A column of a kind this version doesn't know — a newer client's. Drawn
   * as a dimmed placeholder, so the layout around it stays where it was.
   */
  | { role: "unknown"; kind: string }
);

const WIDTHS = { whole: 240, key: 160, added: 200, source: 96, unknown: 120 };

/**
 * A field's group header, which is its name: only fields with keys have one,
 * and a field without is left ungrouped. Glide identifies a group by this
 * string, so it says nothing about whether the group is expanded — the
 * disclosure triangle is an icon the view supplies per group.
 */
export function fieldGroup(field: DatasetField): string {
  return field.def.name;
}

/** The title of a column added at `path`: its last key, or else its root. */
export function addedTitle(
  path: ColumnPath,
  fields: readonly DatasetField[],
): string {
  const last = path.keys.at(-1);
  if (last !== undefined) return last;
  if ("instance" in path.root) return path.root.instance;
  const { field } = path.root;
  return fields.find(f => f.id === field)?.def.name ?? field;
}

/** A path as a reader names it: `toolsContext › create_task › title`. */
export function pathLabel(
  path: ColumnPath,
  fields: readonly DatasetField[],
): string {
  const root =
    "instance" in path.root
      ? `◆ ${path.root.instance}`
      : (fields.find(f => f.id === pathField(path))?.def.name ??
        pathField(path) ??
        "");
  return [root, ...path.keys].join(" › ");
}

/**
 * The table's columns, left to right, as `layout` orders them, leaving out
 * hidden ones: each field — split into its shown keys when `expanded` has it
 * — each added column, the source, and a placeholder for any column of a
 * kind this version doesn't know.
 */
export function buildColumns({
  fields,
  layout,
  expanded,
  shortType,
}: {
  fields: readonly DatasetField[];
  /**
   * The reconciled layout ({@link reconcileColumns}), whose fields carry the
   * keys their cells hold.
   */
  layout: ColumnLayout;
  /** Ids of the fields shown split into their keys. */
  expanded: ReadonlySet<string>;
  /** Shortens a type's syntax for a header. */
  shortType: (syntax: string) => string;
}): DatasetColumn[] {
  const byId = new Map(fields.map(f => [f.id, f]));
  const columns: DatasetColumn[] = [];
  for (const [index, entry] of layout.entries()) {
    if (entry.hidden) continue;
    const slot = { index };
    switch (entry.kind) {
      case "field": {
        const field = byId.get(entry.fieldId);
        if (!field) break;
        const type = shortType(field.def.type.syntax);
        const base = primitiveBase(field.def.type);
        const whole: DatasetColumn = {
          id: field.id,
          title: field.def.name,
          type,
          role: "whole",
          path: fieldPath(field.id),
          width: WIDTHS.whole,
          slot,
          ...(base && { base }),
        };
        if (entry.keys.length === 0) {
          columns.push(whole);
          break;
        }
        const group = fieldGroup(field);
        const shown = entry.keys.filter(k => !k.hidden);
        if (!expanded.has(field.id) || shown.length === 0) {
          columns.push({ ...whole, group });
          break;
        }
        for (const { key } of shown) {
          const path = fieldPath(field.id, [key]);
          columns.push({
            id: columnPathId(path),
            title: key,
            group,
            role: "key",
            path,
            width: WIDTHS.key,
            slot: { index, key },
          });
        }
        break;
      }
      case "added":
        columns.push({
          id: columnPathId(entry.path),
          title: entry.title ?? addedTitle(entry.path, fields),
          role: "added",
          path: entry.path,
          width: WIDTHS.added,
          slot,
        });
        break;
      case "source":
        columns.push({
          id: "source",
          title: "source",
          role: "source",
          width: WIDTHS.source,
          slot,
        });
        break;
      case "unknown":
        columns.push({
          id: `?${index}`,
          title: "Unknown column",
          type: entry.spec.kind,
          role: "unknown",
          kind: entry.spec.kind,
          width: WIDTHS.unknown,
          slot,
        });
        break;
    }
  }
  return columns;
}

/**
 * The field a column's header menu renames or deletes, or `undefined` for a
 * column that isn't a field: the source, an added column, and the per-key
 * columns of an expanded field, which are paths inside a field rather than
 * fields of their own.
 */
export function menuFieldId(
  column: DatasetColumn | undefined,
): string | undefined {
  return column?.role === "whole" ? pathField(column.path) : undefined;
}

/**
 * The path a column reads, which can name a row — `undefined` for the source
 * and an unknown column, which aren't paths.
 */
export function columnPath(
  column: DatasetColumn | undefined,
): ColumnPath | undefined {
  return column && "path" in column ? column.path : undefined;
}

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Whether the grid may move the column at `from` to `to` — Glide's indexes,
 * which remove the column and insert it at `to`. A field's keys are always
 * columns of that field, drawn under one group header, so:
 *
 * - a key column can only land inside its own field's group;
 * - any other column can't land inside an expanded field's group.
 *
 * An expanded field can't be dragged as a whole, since Glide moves single
 * columns: collapse it first, or use the picker.
 */
export function canMoveColumn(
  columns: readonly DatasetColumn[],
  from: number,
  to: number,
): boolean {
  const column = columns[from];
  if (!column || !columns[to]) return false;
  if (from === to) return true;
  if (column.role === "key") {
    const target = columns[to];
    return target.role === "key" && target.slot.index === column.slot.index;
  }
  // Every expanded field's keys must stay side by side.
  const after = moved(columns, from, to);
  const ended = new Set<number>();
  let open: number | undefined;
  for (const c of after) {
    const group = c.role === "key" ? c.slot.index : undefined;
    if (group === open) continue;
    if (open !== undefined) ended.add(open);
    if (group !== undefined && ended.has(group)) return false;
    open = group;
  }
  return true;
}

/**
 * `layout` after the grid moved the column at `from` to `to` (see
 * {@link canMoveColumn}): a key reorders within its field, any other column
 * among the top-level columns. Hidden columns keep their places between the
 * shown ones.
 */
export function movedLayout(
  layout: ColumnLayout,
  columns: readonly DatasetColumn[],
  from: number,
  to: number,
): ColumnLayout {
  const column = columns[from];
  if (!column || from === to || !canMoveColumn(columns, from, to)) {
    return layout;
  }
  const after = moved(columns, from, to);
  const { index } = column.slot;
  const entry = layout[index];
  if (column.role === "key" && entry?.kind === "field") {
    const order = after.flatMap(c =>
      c.role === "key" && c.slot.index === index ? [c.slot.key] : [],
    );
    const shown = new Set(order);
    const keys = reorderVisible(
      entry.keys,
      k => shown.has(k.key),
      order.flatMap(key => entry.keys.filter(k => k.key === key)),
    );
    return layout.map((e, i) => (i === index ? { ...entry, keys } : e));
  }
  const order: number[] = [];
  for (const c of after) {
    if (order.at(-1) !== c.slot.index) order.push(c.slot.index);
  }
  const shown = new Set(order);
  return reorderVisible(
    layout.map((_, i) => i),
    i => shown.has(i),
    order,
  ).map(i => layout[i]);
}

/**
 * Which field each group header belongs to. Glide hands its callbacks a
 * group's name, which is a field's name; two fields sharing a name would
 * share a header anyway, so the first one wins.
 */
export function fieldIdsByGroup(columns: DatasetColumn[]): Map<string, string> {
  const byGroup = new Map<string, string>();
  for (const column of columns) {
    const fieldId = "path" in column ? pathField(column.path) : undefined;
    if (column.group !== undefined && fieldId !== undefined) {
      if (!byGroup.has(column.group)) byGroup.set(column.group, fieldId);
    }
  }
  return byGroup;
}

/**
 * A group header: the field's name, behind a disclosure triangle pointing
 * right when collapsed and down when expanded. Columns outside any group are
 * asked about too, under the empty name — those get no triangle, since there
 * is nothing to disclose.
 */
export function groupHeader(
  group: string,
  fieldIdByGroup: ReadonlyMap<string, string>,
  expanded: ReadonlySet<string>,
): { name: string; icon?: string } {
  const fieldId = fieldIdByGroup.get(group);
  if (fieldId === undefined) return { name: group };
  return {
    name: group,
    icon: expanded.has(fieldId) ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED,
  };
}

/**
 * What an in-place edit changes: a field's cell, or — through an added
 * column — one argument of one of the row's resource instances, whose
 * current spec the edit is applied to. See `specs/datasets.md` §Q.4.
 */
export type EditTarget =
  | { fieldId: string }
  | { instance: string; arg: string; spec: ResourceInstanceInput };

/** A cell the grid types into in place — see {@link editableCell}. */
export type EditableCell = EditTarget & {
  /** The type it's typed into as. */
  base: EditableBase;
  /** What it holds, or `undefined` when it's empty. */
  value?: string | number | boolean;
};

/** A primitive's base, when it's one the grid can type into. */
function primitiveEditBase(value: unknown): EditableBase | undefined {
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean"
    ? type
    : undefined;
}

/**
 * The cell of `column` in `row` if it's typed into in place, or `undefined`
 * when it's read-only in the grid. Editable means either:
 *
 * - a field's whole column (not a key inside it), a field typed `string`,
 *   `number`, or `boolean`, and a cell that's empty or holds a plain
 *   primitive of that type (`specs/datasets.md` §P.2); or
 * - an added column whose path ends at one of the row's instances'
 *   arguments — directly, or through references — that holds a plain
 *   `string`, `number`, or `boolean`, typed in as that (§Q.4).
 *
 * Anything else — a template, say, whose interpolations a text box would
 * flatten, or a value nested inside an argument — is edited in the details
 * pane instead.
 */
export function editableCell(
  row: DatasetRow | undefined,
  column: DatasetColumn | undefined,
): EditableCell | undefined {
  if (!row || !column) return undefined;
  if (column.role === "added") return editableArgument(row, column.path);
  if (column.role !== "whole" || !column.base) return undefined;
  const { base } = column;
  const fieldId = pathField(column.path);
  if (fieldId === undefined) return undefined;
  const cell = row.cells[fieldId];
  if (!cell) return { base, fieldId };
  if (cell.kind !== "value" || cell.value.kind !== "primitive")
    return undefined;
  const { value } = cell.value;
  return typeof value === base
    ? { base, fieldId, value: value as string | number | boolean }
    : undefined;
}

/** {@link editableCell} for an added column at `path`. */
function editableArgument(
  row: DatasetRow,
  path: ColumnPath,
): EditableCell | undefined {
  const { value: found, argument } = resolveColumnPath(row, path);
  const spec = argument && row.resources?.[argument.instance];
  if (!argument || !spec || typeof found !== "object") return undefined;
  if (found.kind !== "value" || found.value.kind !== "primitive") {
    return undefined;
  }
  const { value } = found.value;
  const base = primitiveEditBase(value);
  if (!base) return undefined;
  return {
    base,
    instance: argument.instance,
    arg: argument.arg,
    spec,
    value: value as string | number | boolean,
  };
}

/** What an in-place editor holds: empty is `undefined` (or `null`, or `""`). */
export type EditorValue = string | number | boolean | null | undefined;

/** Whether an editor's value can be saved into a cell of type `base`. */
export function fitsEditor(base: EditableBase, value: EditorValue): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (base === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeof value === base;
}

/**
 * The cell an editor's value saves as: a typed-in primitive, or `null` —
 * clear the cell — for an empty editor, so a cleared cell has no key rather
 * than an empty string. `undefined` when the value doesn't fit `base` (see
 * {@link fitsEditor}), which a batch skips.
 */
export function editedCell(
  base: EditableBase,
  value: EditorValue,
): ExecutionInput | null | undefined {
  if (!fitsEditor(base, value)) return undefined;
  return committedCell({ kind: "primitive", value: value ?? undefined });
}

/** One cell's edit, located by row and what it changes. */
export type CellEdit = EditTarget & {
  rowId: string;
  /** The new cell, or `null` to clear it. */
  cell: ExecutionInput | null;
};

/** `e`'s target alone, without its base and value. */
function targetOf(e: EditableCell): EditTarget {
  return "fieldId" in e
    ? { fieldId: e.fieldId }
    : { instance: e.instance, arg: e.arg, spec: e.spec };
}

/** One edited grid cell, as the grid reports it: column and row indexes. */
export interface GridEdit {
  col: number;
  row: number;
  value: EditorValue;
}

/**
 * The grid's edits as {@link CellEdit}s, skipping any that land outside the
 * editable set ({@link editableCell}) or don't fit the cell's type — a paste
 * or fill over a range can cover both, and the rest of it still applies.
 */
export function cellEdits(
  edits: readonly GridEdit[],
  columns: readonly DatasetColumn[],
  rowAt: (index: number) => DatasetRow | undefined,
): CellEdit[] {
  const out: CellEdit[] = [];
  for (const { col, row: index, value } of edits) {
    const row = rowAt(index);
    const e = row && editableCell(row, columns[col]);
    if (!e) continue;
    const cell = editedCell(e.base, value);
    if (cell === undefined) continue;
    out.push({ rowId: row.id, ...targetOf(e), cell });
  }
  return out;
}

/** A block of cells in the grid, by column and row index. */
export interface CellRange {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Clearing `ranges` (Delete or Backspace over a selection): a `null` for each
 * editable cell in them that holds something. Read-only cells are left as
 * they are, even inside the selection — the details pane clears those.
 */
export function clearEdits(
  ranges: readonly CellRange[],
  columns: readonly DatasetColumn[],
  rowAt: (index: number) => DatasetRow | undefined,
): CellEdit[] {
  const out: CellEdit[] = [];
  for (const { x, y, width, height } of ranges) {
    for (let index = y; index < y + height; index++) {
      const row = rowAt(index);
      for (let col = x; col < x + width; col++) {
        const e = row && editableCell(row, columns[col]);
        if (e && e.value !== undefined) {
          out.push({ rowId: row.id, ...targetOf(e), cell: null });
        }
      }
    }
  }
  return out;
}

/**
 * A batch of cell edits — one keystroke's, a paste's over a range, a fill's —
 * as one update per row, rows in the order first edited. A cell edited twice
 * keeps its last value. An edit to an instance's argument replaces that
 * whole instance in the update's `resources`, with the argument set — or
 * removed, when cleared — and every other edit to the same instance in the
 * batch applied on top.
 */
export function groupEdits(edits: readonly CellEdit[]): DatasetRowUpdate[] {
  const byRow = new Map<string, DatasetRowUpdate>();
  for (const edit of edits) {
    const { rowId, cell } = edit;
    let update = byRow.get(rowId);
    if (!update) {
      update = { rowId, cells: {} };
      byRow.set(rowId, update);
    }
    if ("fieldId" in edit) {
      update.cells[edit.fieldId] = cell;
      continue;
    }
    const resources = (update.resources ??= {});
    const current = resources[edit.instance] ?? edit.spec;
    const { args: _, ...spec } = current;
    const args = { ...current.args };
    if (cell === null) delete args[edit.arg];
    else args[edit.arg] = cell;
    resources[edit.instance] = {
      ...spec,
      ...(Object.keys(args).length > 0 && { args }),
    };
  }
  return [...byRow.values()];
}

/**
 * `row` with `update`'s cells and resource instances set or cleared, as the
 * server will store it.
 */
export function applyUpdate(
  row: DatasetRow,
  update: DatasetRowUpdate,
): DatasetRow {
  const cells = { ...row.cells };
  for (const [fieldId, cell] of Object.entries(update.cells)) {
    if (cell === null) delete cells[fieldId];
    else cells[fieldId] = cell;
  }
  if (!update.resources) return { ...row, cells };
  const resources = { ...row.resources };
  for (const [name, spec] of Object.entries(update.resources)) {
    if (spec === null) delete resources[name];
    else resources[name] = spec;
  }
  const { resources: _, ...rest } = row;
  return {
    ...rest,
    cells,
    ...(Object.keys(resources).length > 0 && { resources }),
  };
}

/** How the grid should draw one cell. */
export type CellView =
  | { kind: "loading" }
  /** Nothing here: a sparse row. Drawn as a dim dash. */
  | { kind: "empty" }
  /** Not applicable: this row's cell has no such key. */
  | { kind: "n/a" }
  | { kind: "text"; text: string; tone?: "dim" | "link" }
  /** A resource instance, drawn as a chip. */
  | { kind: "chip"; text: string }
  /** A cell of a column this version doesn't know: empty and dimmed. */
  | { kind: "unknown" }
  /**
   * A cell typed into in place (see {@link editableCell}): `value` is what
   * its editor starts from, `text` what's drawn — `—` when it's empty.
   */
  | {
      kind: "edit";
      base: EditableBase;
      value: string | number | boolean | undefined;
      text: string;
    };

/** A one-line rendering of an object: `{ db: ◆ db, userId: "u1" }`. */
function previewObject(
  input: Extract<ExecutionInput, { kind: "object" }>,
): string {
  const entries = Object.entries(input.properties);
  if (entries.length === 0) return "{}";
  return `{ ${entries
    .map(
      ([key, child]) =>
        `${key}: ${child.kind === "instance" ? `◆ ${previewCell(child)}` : previewCell(child)}`,
    )
    .join(", ")} }`;
}

/** A typed-in object on one line, with its values: `{ title: "Say hi" }`. */
function previewValueObject(
  value: Extract<PropValue, { kind: "object" }>,
): string {
  const entries = Object.entries(value.properties);
  if (entries.length === 0) return "{}";
  return `{ ${entries
    .map(([key, child]) => `${key}: ${previewPropValue(child)}`)
    .join(", ")} }`;
}

/** How an input is drawn in a column of `role`. */
function inputView(input: ExecutionInput): CellView {
  switch (input.kind) {
    case "instance":
      return { kind: "chip", text: `◆ ${previewCell(input)}` };
    case "object":
      return { kind: "text", text: previewObject(input) };
    default:
      return {
        kind: "text",
        text:
          input.kind === "value" && input.value.kind === "object"
            ? previewValueObject(input.value)
            : previewCell(input),
      };
  }
}

/** What the cell of `column` shows for `row`, which is `undefined` while its page loads. */
export function cellView(
  row: DatasetRow | undefined,
  column: DatasetColumn,
): CellView {
  if (!row) return { kind: "loading" };
  switch (column.role) {
    case "source":
      return row.source?.kind === "trace"
        ? { kind: "text", text: "trace ↗", tone: "link" }
        : row.source?.kind === "playground"
          ? { kind: "text", text: "playground", tone: "dim" }
          : { kind: "empty" };
    case "unknown":
      return { kind: "unknown" };
    default: {
      const found = readColumnPath(row, column.path);
      const e = editableCell(row, column);
      if (e) {
        return {
          kind: "edit",
          base: e.base,
          value: e.value,
          text: typeof found === "object" ? previewCell(found) : "—",
        };
      }
      if (found === "absent") return { kind: "empty" };
      if (found === "n/a") return { kind: "n/a" };
      return inputView(found);
    }
  }
}

/** Fetches `limit` rows starting at `offset`. */
export type FetchRows = (
  offset: number,
  limit: number,
) => Promise<DatasetRow[]>;

/**
 * Rows read a page at a time, so a table of any size holds only the pages
 * that have been scrolled into view.
 *
 * {@link invalidate} marks every page stale rather than dropping it: a stale
 * page keeps serving its rows until its replacement lands, so a refresh
 * redraws in place instead of flashing to loading cells.
 *
 * At most `maxPages` are kept: past that, the pages farthest from the range
 * last asked for are dropped, and fetched again if scrolled back to.
 */
export class RowPager {
  private readonly pages = new Map<
    number,
    { rows: DatasetRow[]; generation: number }
  >();
  /** Pages being fetched, with the generation each was asked for in. */
  private readonly inFlight = new Map<number, number>();
  private generation = 0;
  /** The pages the last {@link ensure} covered — never evicted. */
  private focus = { first: 0, last: 0 };
  private readonly fetchRows: FetchRows;
  private readonly onLoad: (start: number, end: number) => void;
  private readonly onError: (error: Error) => void;
  /** How many rows one fetch asks for. */
  readonly pageSize: number;
  /** The most pages held at once. */
  readonly maxPages: number;

  /**
   * @param fetchRows Fetches one page.
   * @param onLoad Called when a page lands, with the row range it covers.
   * @param onError Called when a page fails to load.
   * @param pageSize How many rows one fetch asks for.
   * @param maxPages The most pages held at once.
   */
  constructor(
    fetchRows: FetchRows,
    onLoad: (start: number, end: number) => void,
    onError: (error: Error) => void,
    pageSize = 100,
    maxPages = 20,
  ) {
    this.fetchRows = fetchRows;
    this.onLoad = onLoad;
    this.onError = onError;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
  }

  /** The row at `index`, if its page has loaded. */
  get(index: number): DatasetRow | undefined {
    const page = this.pages.get(Math.floor(index / this.pageSize));
    return page?.rows[index % this.pageSize];
  }

  /** Fetches whichever pages covering rows `[start, end)` aren't current. */
  ensure(start: number, end: number): void {
    if (end <= start) return;
    const first = Math.floor(start / this.pageSize);
    const last = Math.floor((end - 1) / this.pageSize);
    this.focus = { first, last };
    for (let page = first; page <= last; page++) {
      if (this.pages.get(page)?.generation === this.generation) continue;
      if (this.inFlight.get(page) === this.generation) continue;
      this.load(page);
    }
  }

  /**
   * Applies `updates` to whichever of their rows are loaded, at once — the
   * optimistic half of an edit. A patched page moves to a new generation, so
   * a fetch already in flight — which may have read the rows before the edit
   * reached the server — can't overwrite it; pages that were current stay
   * current. A failed save is undone by reloading ({@link invalidate}).
   */
  patch(updates: readonly DatasetRowUpdate[]): void {
    const byId = new Map(updates.map(u => [u.rowId, u]));
    const previous = this.generation++;
    for (const [page, held] of this.pages) {
      let rows: DatasetRow[] | undefined;
      held.rows.forEach((row, index) => {
        const update = byId.get(row.id);
        if (!update) return;
        rows ??= [...held.rows];
        rows[index] = applyUpdate(row, update);
      });
      if (rows) this.pages.set(page, { rows, generation: this.generation });
      else if (held.generation === previous) {
        this.pages.set(page, { ...held, generation: this.generation });
      }
    }
  }

  /** Marks every page stale; the next {@link ensure} refetches what it covers. */
  invalidate(): void {
    this.generation++;
  }

  /** Drops the pages farthest from {@link focus} until at most `maxPages` remain. */
  private evict(): void {
    if (this.pages.size <= this.maxPages) return;
    const { first, last } = this.focus;
    const distance = (page: number) =>
      page < first ? first - page : page > last ? page - last : 0;
    const farthest = [...this.pages.keys()].sort(
      (a, b) => distance(b) - distance(a),
    );
    for (const page of farthest.slice(0, this.pages.size - this.maxPages)) {
      if (distance(page) > 0) this.pages.delete(page);
    }
  }

  private load(page: number): void {
    const generation = this.generation;
    this.inFlight.set(page, generation);
    const offset = page * this.pageSize;
    this.fetchRows(offset, this.pageSize).then(
      rows => {
        if (this.inFlight.get(page) === generation) this.inFlight.delete(page);
        // A page from before an invalidate is still better than nothing, but
        // never replaces one fetched after it.
        const current = this.pages.get(page);
        if (current && current.generation > generation) return;
        this.pages.set(page, { rows, generation });
        this.evict();
        this.onLoad(offset, offset + rows.length);
      },
      (error: unknown) => {
        if (this.inFlight.get(page) === generation) this.inFlight.delete(page);
        this.onError(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }
}

/**
 * How one dataset's table is laid out for this viewer: which fields are
 * expanded into their keys, and any columns resized by hand. Kept in
 * `localStorage` per dataset — a per-viewer convenience, never part of the
 * dataset itself.
 */
export interface DatasetLayout {
  /** Ids of the fields shown split into their keys. */
  expanded: ReadonlySet<string>;
  /** Column id → the width it was dragged to. See {@link DatasetColumn.id}. */
  widths: Record<string, number>;
}

/** The layout a dataset opens with before anything is expanded or resized. */
export const DEFAULT_LAYOUT: DatasetLayout = {
  expanded: new Set(),
  widths: {},
};

/** Where one dataset's {@link DatasetLayout} is stored. */
export function layoutStorageKey(
  providerId: string,
  datasetId: string,
): string {
  return `dataset-layout:${providerId}:${datasetId}`;
}

/**
 * Recover a layout from parsed JSON (localStorage), tolerating anything a
 * hand-edited value or an older format might hold: entries that aren't a
 * field id or a usable width are dropped rather than throwing. A field that
 * has since lost its keys, or a column that no longer exists, is harmless —
 * {@link buildColumns} simply never asks about it.
 */
export function parseDatasetLayout(raw: unknown): DatasetLayout {
  if (typeof raw !== "object" || raw === null) return DEFAULT_LAYOUT;
  const { expanded, widths } = raw as {
    expanded?: unknown;
    widths?: unknown;
  };
  const cleanWidths: Record<string, number> = {};
  if (typeof widths === "object" && widths !== null) {
    for (const [id, width] of Object.entries(widths)) {
      if (typeof width === "number" && Number.isFinite(width) && width > 0) {
        cleanWidths[id] = width;
      }
    }
  }
  return {
    expanded: new Set(
      Array.isArray(expanded)
        ? expanded.filter(id => typeof id === "string")
        : [],
    ),
    widths: cleanWidths,
  };
}

/**
 * `layout` without what it remembers of a deleted field: that it was
 * expanded, and the widths of its columns (see {@link DatasetColumn.id}).
 */
export function layoutWithoutField(
  layout: DatasetLayout,
  fieldId: string,
): DatasetLayout {
  const expanded = new Set(layout.expanded);
  expanded.delete(fieldId);
  const widths = Object.fromEntries(
    Object.entries(layout.widths).filter(
      ([id]) => id !== fieldId && !id.startsWith(`${fieldId}/`),
    ),
  );
  return { expanded, widths };
}

/** A layout as it's stored: a `Set` doesn't survive `JSON.stringify`. */
export function serializeDatasetLayout(layout: DatasetLayout): string {
  return JSON.stringify({
    expanded: [...layout.expanded],
    widths: layout.widths,
  });
}
