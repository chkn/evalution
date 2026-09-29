// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { shortId } from "../../shared/helpers";
import type { TraceSummary, VariationInfo } from "../../shared/types";
import { variationLabel } from "./prompt-ref";
import { tableModeWidth as baseTableModeWidth } from "./summary-list";

const ALL_KEYS = [
  "startTime",
  "spanCount",
  "duration",
  "totalTokens",
  "model",
  "cost",
  "annotations",
  "version",
  "variation",
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
  version: false,
  variation: false,
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

/** Each column's pixel width in table mode, sized for its own content. */
export const TRACE_COLUMN_WIDTH_PX: Record<TraceColumnKey, number> = {
  startTime: 100,
  spanCount: 40,
  duration: 55,
  totalTokens: 56,
  model: 110,
  cost: 64,
  annotations: 90,
  version: 120,
  variation: 110,
};

/**
 * The sidebar width the table-mode toggle resizes to: enough to comfortably
 * fit the Name column plus every currently-visible column (see
 * `summary-list.ts`'s {@link baseTableModeWidth} for the clamping).
 */
export function tableModeWidth(columns: TraceColumnState[]): number {
  return baseTableModeWidth(
    columns.filter(c => c.visible).map(c => TRACE_COLUMN_WIDTH_PX[c.key]),
  );
}

// ─── Prompt version and variation ───────────────────────────────────────────

/**
 * What the Version column shows for a trace: the short sha of the commit it
 * ran at; `—` for a run that recorded none (one on a dirty working tree).
 */
export function traceVersionLabel(
  trace: Pick<TraceSummary, "promptVersion">,
): string {
  const id = trace.promptVersion;
  return id ? shortId(id) : "—";
}

/**
 * What the Variation column shows for a trace: the variation's name when it
 * has one, else its short id; `—` for a run of the source as it was.
 */
export function traceVariationLabel(
  trace: Pick<TraceSummary, "promptVariation">,
  variations: Record<string, VariationInfo>,
): string {
  const id = trace.promptVariation;
  if (!id) return "—";
  const info = variations[id];
  return info?.names.length ? variationLabel(info) : shortId(id);
}
