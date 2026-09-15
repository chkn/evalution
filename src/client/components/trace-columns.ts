// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

const ALL_KEYS = [
  "startTime",
  "spanCount",
  "duration",
  "totalTokens",
  "model",
  "cost",
  "annotations",
] as const;

/** A configurable trace-list column — every one besides the always-shown Name. */
export type TraceColumnKey = (typeof ALL_KEYS)[number];

/** One column's place in the user's chosen order, and whether it's shown. */
export interface TraceColumnState {
  key: TraceColumnKey;
  visible: boolean;
}

/**
 * Whether each column starts out shown. The original three (date, spans,
 * duration) were always visible before the column picker existed, so they
 * stay on by default; the ones added alongside the picker start off so an
 * existing user's table doesn't suddenly grow four new columns they didn't
 * ask for.
 */
const DEFAULT_VISIBLE: Record<TraceColumnKey, boolean> = {
  startTime: true,
  spanCount: true,
  duration: true,
  totalTokens: false,
  model: false,
  cost: false,
  annotations: false,
};

/** Order and visibility a fresh install (or corrupted storage) falls back to. */
export const DEFAULT_TRACE_COLUMNS: TraceColumnState[] = ALL_KEYS.map(key => ({
  key,
  visible: DEFAULT_VISIBLE[key],
}));

/**
 * Recover a column layout from parsed JSON (localStorage), tolerating
 * anything a hand-edited value or an older/newer column set might throw at
 * it: malformed entries and unknown keys are dropped, a repeated key keeps
 * only its first occurrence, and any known key missing from the stored value
 * is appended at its own {@link DEFAULT_VISIBLE} visibility — so a user who
 * saved a layout before a given column existed sees it appear exactly as a
 * fresh install would.
 */
export function parseTraceColumns(raw: unknown): TraceColumnState[] {
  const known = new Set<TraceColumnKey>(ALL_KEYS);
  const seen = new Set<TraceColumnKey>();
  const result: TraceColumnState[] = [];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { key?: unknown }).key === "string" &&
        typeof (entry as { visible?: unknown }).visible === "boolean" &&
        known.has((entry as { key: TraceColumnKey }).key) &&
        !seen.has((entry as { key: TraceColumnKey }).key)
      ) {
        const key = (entry as { key: TraceColumnKey }).key;
        seen.add(key);
        result.push({ key, visible: (entry as { visible: boolean }).visible });
      }
    }
  }

  for (const key of ALL_KEYS) {
    if (!seen.has(key)) result.push({ key, visible: DEFAULT_VISIBLE[key] });
  }

  return result;
}

/** Toggle one column's visibility, leaving its position in the order untouched. */
export function toggleTraceColumn(
  columns: TraceColumnState[],
  key: TraceColumnKey,
): TraceColumnState[] {
  return columns.map(c => (c.key === key ? { ...c, visible: !c.visible } : c));
}

/**
 * Move the column at `fromIndex` to `toIndex`, shifting everything between
 * them over by one — what dragging a column's grab handle to a new spot
 * produces. Returns `columns` unchanged for a no-op or out-of-range move.
 */
export function reorderTraceColumns(
  columns: TraceColumnState[],
  fromIndex: number,
  toIndex: number,
): TraceColumnState[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= columns.length ||
    toIndex < 0 ||
    toIndex >= columns.length
  ) {
    return columns;
  }
  const next = [...columns];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

// ─── Table-mode width ───────────────────────────────────────────────────────

/** Each column's pixel width in table mode. Mirrors `.trace-table-col-*` in `styles.css` — keep the two in sync. */
const COLUMN_WIDTH_PX: Record<TraceColumnKey, number> = {
  startTime: 92,
  spanCount: 40,
  duration: 60,
  totalTokens: 56,
  model: 110,
  cost: 64,
  annotations: 90,
};

/** The Name column has no fixed CSS width (it flexes to fill the row) — a comfortable minimum for it, not a mirrored stylesheet value. */
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
 * fit the Name column plus every currently-visible column, clamped to
 * `[`{@link MIN_TABLE_MODE_WIDTH}`, `{@link MAX_TABLE_MODE_WIDTH}`]`.
 */
export function tableModeWidth(columns: TraceColumnState[]): number {
  const columnsWidth = columns
    .filter(c => c.visible)
    .reduce((sum, c) => sum + COLUMN_WIDTH_PX[c.key], NAME_COLUMN_WIDTH_PX);
  const target = columnsWidth + TABLE_CHROME_WIDTH_PX;
  return Math.min(MAX_TABLE_MODE_WIDTH, Math.max(MIN_TABLE_MODE_WIDTH, target));
}
