// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The dataset table's model, apart from the grid that draws it: which columns
 * it has, what each cell shows, and the paged cache rows are read through.
 * Pure and grid-agnostic — `DatasetView` maps it onto Glide Data Grid.
 *
 * A column is a *path* into a row: a whole field, or one key inside it — a
 * resource's argument, an object's property, or a property of a typed-in
 * object value. The keys come from {@link DatasetRowsOverview}, found in the
 * rows rather than the schema, and merged by name, so one `title` column
 * spans every resource that takes a `title`. A path is also what sorting and
 * filtering will name when they arrive.
 *
 * Some cells are typed into in place — see {@link editableCell}. An edit is
 * reported per cell and sent per row ({@link groupEdits}), and the page it
 * lands on is patched at once ({@link RowPager.patch}), before the server
 * answers.
 */

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
} from "../../shared/types";
import { previewCell, previewPropValue, resourceName } from "./dataset-preview";
import { DISCLOSURE_COLLAPSED, DISCLOSURE_EXPANDED } from "./grid-sprites";

/** Where a column reads from: a field, or one key one level inside it. */
export interface CellPath {
  fieldId: string;
  /** A resource argument's or object property's name. */
  key?: string;
}

/** One column of the dataset table. */
export type DatasetColumn = {
  /** Stable across layouts — resized widths are remembered by it. */
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
} & (
  | {
      /**
       * `whole`: a field in one column. `head`: the column naming which
       * resource fills an expanded field, beside one `key` column per
       * argument. A field of objects has no head: its own cell would only
       * ever read `{…}` next to the columns holding what's in it.
       */
      role: "whole" | "head";
      path: CellPath;
    }
  | { role: "key"; path: Required<CellPath> }
  /** Where the row came from. */
  | { role: "source" }
);

const WIDTHS = { whole: 240, head: 140, key: 160, source: 96 };

/**
 * A field's group header, which is its name: only fields with keys have one,
 * and a field without is left ungrouped. Glide identifies a group by this
 * string, so it says nothing about whether the group is expanded — the
 * disclosure triangle is an icon the view supplies per group.
 */
export function fieldGroup(field: DatasetField): string {
  return field.def.name;
}

/**
 * The table's columns, left to right: each field — split into its keys when
 * `expanded` has it — and then the source.
 */
export function buildColumns({
  fields,
  shape,
  expanded,
  shortType,
}: {
  fields: DatasetField[];
  /** What each field's cells hold — see {@link DatasetRowsOverview.fields}. */
  shape: DatasetRowsOverview["fields"];
  /** Ids of the fields shown split into their keys. */
  expanded: ReadonlySet<string>;
  /** Shortens a type's syntax for a header. */
  shortType: (syntax: string) => string;
}): DatasetColumn[] {
  const columns: DatasetColumn[] = [];
  for (const field of fields) {
    const fieldShape = shape[field.id];
    const fieldKeys = fieldShape?.keys ?? [];
    const type = shortType(field.def.type.syntax);
    const path = { fieldId: field.id };
    const base = primitiveBase(field.def.type);
    const whole: DatasetColumn = {
      id: field.id,
      title: field.def.name,
      type,
      role: "whole",
      path,
      width: WIDTHS.whole,
      ...(base && { base }),
    };
    if (fieldKeys.length === 0) {
      columns.push(whole);
      continue;
    }
    const group = fieldGroup(field);
    if (!expanded.has(field.id)) {
      columns.push({ ...whole, group });
      continue;
    }
    if (fieldShape?.resource) {
      columns.push({
        id: `${field.id}/`,
        title: field.def.name,
        type,
        group,
        role: "head",
        path,
        width: WIDTHS.head,
      });
    }
    for (const key of fieldKeys) {
      columns.push({
        id: `${field.id}/${key}`,
        title: key,
        group,
        role: "key",
        path: { fieldId: field.id, key },
        width: WIDTHS.key,
      });
    }
  }
  columns.push({
    id: "source",
    title: "source",
    role: "source",
    width: WIDTHS.source,
  });
  return columns;
}

/**
 * The field a column's header menu renames or deletes, or `undefined` for a
 * column that has no menu: the source, and the per-key columns of an expanded
 * field, which are paths inside a field rather than fields of their own.
 */
export function menuFieldId(
  column: DatasetColumn | undefined,
): string | undefined {
  return column?.role === "whole" || column?.role === "head"
    ? column.path.fieldId
    : undefined;
}

/**
 * Which field each group header belongs to. Glide hands its callbacks a
 * group's name, which is a field's name; two fields sharing a name would
 * share a header anyway, so the first one wins.
 */
export function fieldIdsByGroup(columns: DatasetColumn[]): Map<string, string> {
  const byGroup = new Map<string, string>();
  for (const column of columns) {
    if (column.group !== undefined && "path" in column) {
      if (!byGroup.has(column.group)) {
        byGroup.set(column.group, column.path.fieldId);
      }
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
 * What a path reads in a row: the input there, `"absent"` when the row has
 * nothing there, or `"n/a"` when the field's cell has no such key — a
 * different resource, taking other arguments, say.
 *
 * A typed-in object's property is a `PropValue`, not an `ExecutionInput`; it
 * comes back wrapped as the value cell it would have been on its own.
 */
export function readPath(
  row: DatasetRow,
  path: CellPath,
): ExecutionInput | "absent" | "n/a" {
  const cell = row.cells[path.fieldId];
  if (!cell) return "absent";
  const { key } = path;
  if (key === undefined) return cell;
  if (cell.kind === "value") {
    const { value } = cell;
    return value.kind === "object" && Object.hasOwn(value.properties, key)
      ? { kind: "value", value: value.properties[key] }
      : "n/a";
  }
  const inner =
    cell.kind === "resource"
      ? cell.args
      : cell.kind === "object"
        ? cell.properties
        : undefined;
  return inner && Object.hasOwn(inner, key) ? inner[key] : "n/a";
}

/** A cell the grid types into in place — see {@link editableCell}. */
export interface EditableCell {
  /** The type it's typed into as. */
  base: EditableBase;
  /** The field it belongs to. */
  fieldId: string;
  /** What it holds, or `undefined` when it's empty. */
  value?: string | number | boolean;
}

/**
 * The cell of `column` in `row` if it's typed into in place, or `undefined`
 * when it's read-only in the grid. Editable means: a field's whole column
 * (not a key inside it), a field typed `string`, `number`, or `boolean`, and
 * a cell that's empty or holds a plain primitive of that type. Anything else
 * — a template, say, whose interpolations a text box would flatten — is
 * edited in the details pane instead. See `specs/datasets.md` §P.2.
 */
export function editableCell(
  row: DatasetRow | undefined,
  column: DatasetColumn | undefined,
): EditableCell | undefined {
  if (!row || column?.role !== "whole" || !column.base) return undefined;
  const { base } = column;
  const { fieldId } = column.path;
  const cell = row.cells[fieldId];
  if (!cell) return { base, fieldId };
  if (cell.kind !== "value" || cell.value.kind !== "primitive")
    return undefined;
  const { value } = cell.value;
  return typeof value === base
    ? { base, fieldId, value: value as string | number | boolean }
    : undefined;
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

/** One cell's edit, located by row and field. */
export interface CellEdit {
  rowId: string;
  fieldId: string;
  /** The new cell, or `null` to clear it. */
  cell: ExecutionInput | null;
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
    out.push({ rowId: row.id, fieldId: e.fieldId, cell });
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
          out.push({ rowId: row.id, fieldId: e.fieldId, cell: null });
        }
      }
    }
  }
  return out;
}

/**
 * A batch of cell edits — one keystroke's, a paste's over a range, a fill's —
 * as one update per row, rows in the order first edited. A cell edited twice
 * keeps its last value.
 */
export function groupEdits(edits: readonly CellEdit[]): DatasetRowUpdate[] {
  const byRow = new Map<string, DatasetRowUpdate>();
  for (const { rowId, fieldId, cell } of edits) {
    let update = byRow.get(rowId);
    if (!update) {
      update = { rowId, cells: {} };
      byRow.set(rowId, update);
    }
    update.cells[fieldId] = cell;
  }
  return [...byRow.values()];
}

/** `row` with `update`'s cells set or cleared, as the server will store it. */
export function applyUpdate(
  row: DatasetRow,
  update: DatasetRowUpdate,
): DatasetRow {
  const cells = { ...row.cells };
  for (const [fieldId, cell] of Object.entries(update.cells)) {
    if (cell === null) delete cells[fieldId];
    else cells[fieldId] = cell;
  }
  return { ...row, cells };
}

/** How the grid should draw one cell. */
export type CellView =
  | { kind: "loading" }
  /** Nothing here: a sparse row. Drawn as a dim dash. */
  | { kind: "empty" }
  /** Not applicable: this row's resource doesn't take this argument. */
  | { kind: "n/a" }
  | { kind: "text"; text: string; tone?: "dim" | "link" }
  /** A resource, drawn as a chip. */
  | { kind: "chip"; text: string }
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
        `${key}: ${child.kind === "resource" ? `◆ ${previewCell(child)}` : previewCell(child)}`,
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
function inputView(
  input: ExecutionInput,
  role: "whole" | "head" | "key",
): CellView {
  switch (input.kind) {
    case "resource":
      return {
        kind: "chip",
        // An expanded field's head names the resource; the arguments have
        // their own columns beside it.
        text: `◆ ${role === "head" ? resourceName(input.uri) : previewCell(input)}`,
      };
    case "object":
      return role === "head"
        ? { kind: "text", text: "{…}", tone: "dim" }
        : { kind: "text", text: previewObject(input) };
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
    default: {
      const found = readPath(row, column.path);
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
      return inputView(found, column.role);
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
