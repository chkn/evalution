// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** Where the collapsed check runs are remembered, across traces. */
export const COLLAPSED_CHECKS_KEY = "evalution.traceChecksCollapsed";

/** How many traces' collapsed runs are remembered. */
export const MAX_REMEMBERED_TRACES = 50;

/**
 * One trace's remembered state: its key and the keys of its collapsed runs.
 * Entries are ordered most recently opened first.
 */
export type CollapsedEntry = [traceKey: string, collapsedRuns: string[]];

/**
 * `entries` with `traceKey` moved to the front (as the trace most recently
 * opened), its collapsed runs replaced by `collapsedRuns` if given, and the
 * entries opened longest ago dropped beyond `limit`.
 */
export function touchEntry(
  entries: CollapsedEntry[],
  traceKey: string,
  collapsedRuns?: string[],
  limit = MAX_REMEMBERED_TRACES,
): CollapsedEntry[] {
  const previous = entries.find(([key]) => key === traceKey);
  const entry: CollapsedEntry = [
    traceKey,
    collapsedRuns ?? previous?.[1] ?? [],
  ];
  const rest = entries.filter(([key]) => key !== traceKey);
  return [entry, ...rest].slice(0, limit);
}

/** The key a trace is remembered under. */
export function traceEntryKey(providerId: string, traceId: string): string {
  return JSON.stringify([providerId, traceId]);
}

/** The stored entries; empty when storage is unavailable or holds junk. */
function readEntries(): CollapsedEntry[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(COLLAPSED_CHECKS_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is CollapsedEntry =>
        Array.isArray(e) &&
        typeof e[0] === "string" &&
        Array.isArray(e[1]) &&
        e[1].every(run => typeof run === "string"),
    );
  } catch {
    return [];
  }
}

function writeEntries(entries: CollapsedEntry[]): void {
  try {
    localStorage.setItem(COLLAPSED_CHECKS_KEY, JSON.stringify(entries));
  } catch {
    /* A convenience: storage may refuse. */
  }
}

/**
 * Recalls the runs the viewer collapsed on a trace, and counts the trace as
 * just opened — so it's the last to be forgotten.
 */
export function openCollapsedRuns(traceKey: string): Set<string> {
  const entries = touchEntry(readEntries(), traceKey);
  writeEntries(entries);
  return new Set(entries[0][1]);
}

/** Remembers the runs collapsed on a trace, counting it as just opened. */
export function saveCollapsedRuns(
  traceKey: string,
  collapsedRuns: ReadonlySet<string>,
): void {
  writeEntries(touchEntry(readEntries(), traceKey, [...collapsedRuns]));
}
