// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect } from "react";
import { pullSync } from "../api";

/** Coming back to the window often is no reason to pull often. */
const MIN_PULL_INTERVAL_MS = 10_000;

/** What {@link watchFocus} listens on. */
export interface WatchFocusOptions {
  win: EventTarget;
  doc: EventTarget & { visibilityState: DocumentVisibilityState };
  onFocus: () => void;
  /** The least time between two calls of `onFocus`, in ms. */
  minIntervalMs?: number;
  now?: () => number;
}

/**
 * Calls `onFocus` when the window regains focus or its tab is shown again,
 * at most once per `minIntervalMs`. Returns a function that stops it.
 */
export function watchFocus({
  win,
  doc,
  onFocus,
  minIntervalMs = MIN_PULL_INTERVAL_MS,
  now = Date.now,
}: WatchFocusOptions): () => void {
  let last = Number.NEGATIVE_INFINITY;
  const fire = () => {
    if (now() - last < minIntervalMs) return;
    last = now();
    onFocus();
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") fire();
  };
  win.addEventListener("focus", fire);
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    win.removeEventListener("focus", fire);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Asks the server to pull the project's synced databases whenever you come
 * back to the playground, so another machine's work is there to see. What
 * the pull brings arrives as the usual change events.
 */
export function usePullOnFocus(): void {
  useEffect(
    () =>
      watchFocus({
        win: window,
        doc: document,
        onFocus: () => {
          pullSync().catch(() => {
            /* the next focus, or the server's own interval, pulls instead */
          });
        },
      }),
    [],
  );
}
