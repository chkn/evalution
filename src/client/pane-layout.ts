// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** A column of tabs in the main content area. */
export interface PaneState<T> {
  id: string;
  tabs: T[];
  activeTabKey: string | null;
}

/** The outcome of {@link placeTab}. */
export interface Placement<T> {
  panes: PaneState<T>[];
  /** The pane that should end up focused. */
  focusId: string;
  /** Set when the tab was already open there, so the pane should be flashed. */
  flashId?: string;
  /** Set when a new pane was created to the right of this one. */
  splitFrom?: string;
}

/**
 * Places `tab` in the pane layout.
 *
 * A tab that's already open anywhere is just focused (and swapped for `tab`
 * when `replace` is set). Otherwise it goes in `fromPaneId` itself, unless
 * `split` is set, in which case it goes in the adjacent pane (preferring the
 * right one), creating `newPaneId` to the right if `fromPaneId` is the only
 * pane.
 */
export function placeTab<T>(
  panes: PaneState<T>[],
  fromPaneId: string,
  tab: T,
  keyOf: (tab: T) => string,
  options: { replace?: boolean; split?: boolean },
  newPaneId: () => string,
): Placement<T> {
  const key = keyOf(tab);
  const existing = panes.find(p => p.tabs.some(t => keyOf(t) === key));
  if (existing) {
    return {
      panes: panes.map(p =>
        p.id === existing.id
          ? {
              ...p,
              tabs: options.replace
                ? p.tabs.map(t => (keyOf(t) === key ? tab : t))
                : p.tabs,
              activeTabKey: key,
            }
          : p,
      ),
      focusId: existing.id,
      flashId: existing.id,
    };
  }

  const idx = panes.findIndex(p => p.id === fromPaneId);
  if (idx < 0) return { panes, focusId: fromPaneId };

  let targetId = fromPaneId;
  let next = panes;
  let splitFrom: string | undefined;
  if (options.split) {
    const adjacent = panes[idx + 1]?.id ?? panes[idx - 1]?.id;
    if (adjacent) {
      targetId = adjacent;
    } else {
      targetId = newPaneId();
      next = [...panes];
      next.splice(idx + 1, 0, { id: targetId, tabs: [], activeTabKey: null });
      splitFrom = fromPaneId;
    }
  }

  return {
    panes: next.map(p =>
      p.id === targetId
        ? { ...p, tabs: [...p.tabs, tab], activeTabKey: key }
        : p,
    ),
    focusId: targetId,
    ...(splitFrom && { splitFrom }),
  };
}
