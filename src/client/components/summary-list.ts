// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** Which way a {@link SortState} orders its column. */
export type SortDir = "asc" | "desc";

/** The column a summary list's table is sorted by, and which way. */
export interface SortState {
  /** A column key, or `"name"` for the always-shown Name column. */
  key: string;
  dir: SortDir;
}

/** What a column sorts by — `undefined` for an item with no value, which always sorts last. */
export type SortValue = number | string | undefined;

/**
 * The sort after clicking `key`'s header: the same column flips direction,
 * a new one starts descending.
 */
export function nextSort(prev: SortState, key: string): SortState {
  return prev.key === key
    ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
    : { key, dir: "desc" };
}

/**
 * A sorted copy of `items`. An item whose value is `undefined` (a trace still
 * running has no duration, say) always sorts last, regardless of direction.
 */
export function sortItems<T>(
  items: T[],
  sortValue: (item: T) => SortValue,
  dir: SortDir,
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = sortValue(a);
    const bv = sortValue(b);
    if (av === undefined) return bv === undefined ? 0 : 1;
    if (bv === undefined) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * sign;
    }
    return (av - bv) * sign;
  });
}

// ─── Table-mode width ───────────────────────────────────────────────────────

/** The Name column has no fixed width (it flexes to fill the row) — a comfortable minimum for it. */
const NAME_COLUMN_WIDTH_PX = 120;

/** Padding/borders the table needs beyond its columns' own widths. */
const TABLE_CHROME_WIDTH_PX = 24;

/**
 * However narrow the visible columns are, don't resize below this — it's
 * comfortably past the `min-width: 325px` container-query breakpoint
 * (`styles.css`) that swaps cards for the table, so the toggle reliably
 * lands in table mode even with just one or two columns shown.
 */
const MIN_TABLE_MODE_WIDTH = 340;

/**
 * However wide the visible columns get, don't resize past this — enabling
 * every column shouldn't be able to make the sidebar eat the whole window.
 */
const MAX_TABLE_MODE_WIDTH = 480;

/**
 * The sidebar width the table-mode toggle resizes to: enough to comfortably
 * fit the Name column plus columns of the given pixel widths, clamped to
 * `[`{@link MIN_TABLE_MODE_WIDTH}`, `{@link MAX_TABLE_MODE_WIDTH}`]`.
 */
export function tableModeWidth(columnWidths: number[]): number {
  const target =
    columnWidths.reduce((sum, w) => sum + w, NAME_COLUMN_WIDTH_PX) +
    TABLE_CHROME_WIDTH_PX;
  return Math.min(MAX_TABLE_MODE_WIDTH, Math.max(MIN_TABLE_MODE_WIDTH, target));
}
