// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A dataset's shared column layout, as the grid and the Columns picker edit
 * it: one ordered list of columns, each shown or hidden, with a field's keys
 * nested under it. Stored flat as `Dataset.columns` and reconciled with the
 * dataset's actual fields and rows on read, the way `parseTraceColumns`
 * reconciles the trace list's. Pure. See `specs/datasets.md` §Q.3.
 */

import {
  type ColumnPath,
  columnPathId,
  type DatasetColumnSpec,
  type ForeignColumnSpec,
  fieldPath,
  isKnownColumn,
  pathField,
} from "../../shared/column-paths";
import type { DatasetField, DatasetRowsOverview } from "../../shared/types";

/** One key of a field, nested under it in the layout. */
export interface LayoutKey {
  key: string;
  hidden: boolean;
  /** Kept as stored; the grid titles a key by its name. */
  title?: string;
}

/** One top-level column of the layout. */
export type LayoutColumn =
  /** A field, derived from the schema, with the keys its cells hold. */
  | {
      kind: "field";
      fieldId: string;
      hidden: boolean;
      keys: LayoutKey[];
      /** Kept as stored; the grid titles a field by its name. */
      title?: string;
    }
  /** A column added from the picker at any other path. */
  | { kind: "added"; path: ColumnPath; hidden: boolean; title?: string }
  /** Where the row came from. */
  | { kind: "source"; hidden: boolean }
  /** A column of a kind this version doesn't know, kept in its place. */
  | { kind: "unknown"; spec: ForeignColumnSpec; hidden: boolean };

/** The layout: top-level columns in order, a field's keys nested under it. */
export type ColumnLayout = LayoutColumn[];

/**
 * Makes a stored layout fit what the dataset actually has:
 *
 * - an entry for a field that no longer exists, or for a field's key no row
 *   holds any more, is dropped;
 * - a field, or a field key, that isn't listed is appended — a field at the
 *   end, a key at the end of its field — shown, in schema and row order, so
 *   a dataset with no stored layout at all looks as it always has;
 * - a repeated path keeps its first entry;
 * - `source` is appended last when the stored list doesn't mention it;
 * - an entry of a kind this version doesn't know is kept in its place.
 *
 * A path entry naming a field or one of its keys is that field's column
 * whatever its `added` flag says, so a field's columns are never listed
 * twice. Any other path is an added column.
 *
 * @param stored - `Dataset.columns`, if the dataset has a layout.
 * @param fields - The dataset's schema.
 * @param shape - The keys each field's cells hold (`DatasetRowsOverview.fields`).
 */
export function reconcileColumns(
  stored: readonly DatasetColumnSpec[] | undefined,
  fields: readonly DatasetField[],
  shape: DatasetRowsOverview["fields"],
): ColumnLayout {
  const fieldIds = new Set(fields.map(f => f.id));
  const layout: ColumnLayout = [];
  const byField = new Map<string, Extract<LayoutColumn, { kind: "field" }>>();
  const seen = new Set<string>();
  let hasSource = false;

  const fieldEntry = (fieldId: string) => {
    let entry = byField.get(fieldId);
    if (!entry) {
      entry = { kind: "field", fieldId, hidden: false, keys: [] };
      byField.set(fieldId, entry);
      layout.push(entry);
    }
    return entry;
  };

  for (const spec of stored ?? []) {
    const hidden = spec.hidden === true;
    if (!isKnownColumn(spec)) {
      layout.push({ kind: "unknown", spec, hidden });
      continue;
    }
    if (spec.kind === "source") {
      if (hasSource) continue;
      hasSource = true;
      layout.push({ kind: "source", hidden });
      continue;
    }
    const { path, title } = spec;
    const id = columnPathId(path);
    if (seen.has(id)) continue;
    const field = pathField(path);
    if (field !== undefined && !fieldIds.has(field)) continue;
    const [key, ...deeper] = path.keys;
    if (field !== undefined && key === undefined) {
      // The field's whole column.
      seen.add(id);
      const entry = fieldEntry(field);
      entry.hidden = hidden;
      if (title !== undefined) entry.title = title;
      continue;
    }
    if (field !== undefined && deeper.length === 0) {
      if (shape[field]?.keys.includes(key)) {
        // One of the field's keys, derived from the rows — even if it was
        // added from the picker before any row held it.
        seen.add(id);
        fieldEntry(field).keys.push({
          key,
          hidden,
          ...(title !== undefined && { title }),
        });
        continue;
      }
      // A derived key no row holds any more.
      if (!spec.added) continue;
    }
    seen.add(id);
    layout.push({
      kind: "added",
      path,
      hidden,
      ...(title !== undefined && { title }),
    });
  }

  for (const field of fields) {
    const entry = fieldEntry(field.id);
    const listed = new Set(entry.keys.map(k => k.key));
    for (const key of shape[field.id]?.keys ?? []) {
      if (!listed.has(key)) entry.keys.push({ key, hidden: false });
    }
  }
  if (!hasSource) layout.push({ kind: "source", hidden: false });
  return layout;
}

const hiddenFlag = (hidden: boolean) =>
  hidden ? { hidden: true as const } : {};

/**
 * A layout as it's stored: flat, a field's whole column followed by one entry
 * per key, and an unknown column's entry as it was read, with its `hidden`
 * flag as now set.
 */
export function serializeColumns(layout: ColumnLayout): DatasetColumnSpec[] {
  return layout.flatMap(serializeColumn);
}

function serializeColumn(column: LayoutColumn): DatasetColumnSpec[] {
  switch (column.kind) {
    case "field":
      return [
        {
          kind: "path",
          path: fieldPath(column.fieldId),
          ...(column.title !== undefined && { title: column.title }),
          ...hiddenFlag(column.hidden),
        },
        ...column.keys.map(
          (k): DatasetColumnSpec => ({
            kind: "path",
            path: fieldPath(column.fieldId, [k.key]),
            ...(k.title !== undefined && { title: k.title }),
            ...hiddenFlag(k.hidden),
          }),
        ),
      ];
    case "added":
      return [
        {
          kind: "path",
          path: column.path,
          ...(column.title !== undefined && { title: column.title }),
          ...hiddenFlag(column.hidden),
          added: true,
        },
      ];
    case "source":
      return [{ kind: "source", ...hiddenFlag(column.hidden) }];
    case "unknown": {
      const { hidden: _, ...rest } = column.spec;
      return [{ ...rest, ...hiddenFlag(column.hidden) }];
    }
  }
}

/** Where a column sits in the layout: a top-level column, or a field's key. */
export type LayoutSlot = { index: number; key?: string };

/** The path a top-level column reads, or `undefined` for one that isn't a path. */
export function layoutColumnPath(column: LayoutColumn): ColumnPath | undefined {
  if (column.kind === "field") return fieldPath(column.fieldId);
  if (column.kind === "added") return column.path;
  return undefined;
}

/** The path the column at `slot` reads, or `undefined` for one that isn't a path. */
export function slotPath(
  layout: ColumnLayout,
  slot: LayoutSlot,
): ColumnPath | undefined {
  const column = layout[slot.index];
  if (!column) return undefined;
  if (slot.key !== undefined) {
    return column.kind === "field"
      ? fieldPath(column.fieldId, [slot.key])
      : undefined;
  }
  return layoutColumnPath(column);
}

/**
 * Hides or shows the column at `slot`. Hiding a field hides all its keys
 * with it, since the grid draws none of them; a key hides on its own.
 */
export function setHidden(
  layout: ColumnLayout,
  slot: LayoutSlot,
  hidden: boolean,
): ColumnLayout {
  return layout.map((column, i) => {
    if (i !== slot.index) return column;
    if (slot.key === undefined) return { ...column, hidden };
    if (column.kind !== "field") return column;
    return {
      ...column,
      keys: column.keys.map(k => (k.key === slot.key ? { ...k, hidden } : k)),
    };
  });
}

/** Whether the column at `slot` is hidden, its field's hiding included. */
export function isHidden(layout: ColumnLayout, slot: LayoutSlot): boolean {
  const column = layout[slot.index];
  if (!column) return false;
  if (column.hidden || slot.key === undefined) return column.hidden;
  return (
    column.kind === "field" &&
    !!column.keys.find(k => k.key === slot.key)?.hidden
  );
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    from >= list.length ||
    to < 0 ||
    to >= list.length
  ) {
    return [...list];
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Moves the top-level column at `from` to `to`, as dragging its picker row does. */
export function moveColumn(
  layout: ColumnLayout,
  from: number,
  to: number,
): ColumnLayout {
  return move(layout, from, to);
}

/** Moves a field's key within that field — the only place a key can go. */
export function moveKey(
  layout: ColumnLayout,
  index: number,
  from: number,
  to: number,
): ColumnLayout {
  return layout.map((column, i) =>
    i === index && column.kind === "field"
      ? { ...column, keys: move(column.keys, from, to) }
      : column,
  );
}

/**
 * Removes an added column. A field's columns, the source and an unknown
 * column can only be hidden, so for those this changes nothing.
 */
export function removeColumn(
  layout: ColumnLayout,
  index: number,
): ColumnLayout {
  return layout[index]?.kind === "added"
    ? layout.filter((_, i) => i !== index)
    : layout;
}

/** Where a path already has a column in the layout, if it does. */
export function findPath(
  layout: ColumnLayout,
  path: ColumnPath,
): LayoutSlot | undefined {
  const id = columnPathId(path);
  for (const [index, column] of layout.entries()) {
    const top = layoutColumnPath(column);
    if (top && columnPathId(top) === id) return { index };
    if (column.kind === "field") {
      for (const { key } of column.keys) {
        if (columnPathId(fieldPath(column.fieldId, [key])) === id) {
          return { index, key };
        }
      }
    }
  }
  return undefined;
}

/**
 * Adds a column at `path`, appended at the top level and shown. A path that
 * already has a column — a field, one of its keys, or one added before — is
 * shown where it is instead, so no path is listed twice.
 */
export function addColumn(
  layout: ColumnLayout,
  path: ColumnPath,
): ColumnLayout {
  const existing = findPath(layout, path);
  if (existing) {
    let next = setHidden(layout, existing, false);
    if (existing.key !== undefined) {
      next = setHidden(next, { index: existing.index }, false);
    }
    return next;
  }
  return [...layout, { kind: "added", path, hidden: false }];
}

/**
 * The order `visible` items take within `list` once the visible ones are
 * rearranged into `order`: each visible item's place is filled by the next
 * one in `order`, so hidden items keep their places between them.
 */
export function reorderVisible<T>(
  list: readonly T[],
  isVisible: (item: T) => boolean,
  order: readonly T[],
): T[] {
  const queue = [...order];
  return list.map(item => (isVisible(item) ? (queue.shift() ?? item) : item));
}
