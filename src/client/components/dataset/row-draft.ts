// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A dataset view's unsaved changes to one row, as pure state: proposals fold
 * into it, Save sends it as one update, and it goes stale when the stored row
 * changes under it. See `specs/dataset-views.md` §D.
 */

import { sameJson } from "../../../shared/same-json.ts";
import type { DatasetRow, DatasetRowUpdate } from "../../../shared/types.ts";
import { applyUpdate } from "../dataset-grid.ts";

/** Unsaved changes to one row. */
export interface RowDraft {
  rowId: string;
  /** The stored row the draft was started from. */
  base: DatasetRow;
  /** Every change so far, merged into one update. */
  update: DatasetRowUpdate;
}

/** `b` applied after `a`, as one update: the later value for anything both set. */
export function mergeUpdates(
  a: DatasetRowUpdate,
  b: DatasetRowUpdate,
): DatasetRowUpdate {
  const resources =
    a.resources || b.resources ? { ...a.resources, ...b.resources } : undefined;
  return {
    rowId: a.rowId,
    cells: { ...a.cells, ...b.cells },
    ...(resources && { resources }),
  };
}

/**
 * `draft` with `update` folded in — or a new draft from `stored`, when there
 * is none for its row yet.
 */
export function foldDraft(
  draft: RowDraft | undefined,
  stored: DatasetRow,
  update: DatasetRowUpdate,
): RowDraft {
  if (draft && draft.rowId === update.rowId) {
    return { ...draft, update: mergeUpdates(draft.update, update) };
  }
  return { rowId: stored.id, base: stored, update };
}

/** The row as the draft has it. */
export function draftRow(draft: RowDraft): DatasetRow {
  return applyUpdate(draft.base, draft.update);
}

/**
 * Whether the stored row has changed since the draft was started — saved
 * from the details pane, or another tab — so saving would overwrite that.
 */
export function isStale(
  draft: RowDraft,
  stored: DatasetRow | undefined,
): boolean {
  return stored !== undefined && !sameJson(stored, draft.base);
}

/**
 * Whether the draft would change anything if saved. Compared by value, not
 * spelling: applying an update can reorder a row's keys.
 */
export function hasChanges(draft: RowDraft | undefined): draft is RowDraft {
  return !!draft && !sameJson(draftRow(draft), draft.base);
}

/**
 * The stored row `draft` was started from, if it's for `rowId` and would
 * change something: what a view compares the draft-applied row against.
 * Undefined when the row has no (effective) draft.
 */
export function draftBase(
  draft: RowDraft | undefined,
  rowId: string,
): DatasetRow | undefined {
  return draft?.rowId === rowId && hasChanges(draft) ? draft.base : undefined;
}
