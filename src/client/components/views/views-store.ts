// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useSyncExternalStore } from "react";
import type { ViewList } from "../../../shared/types.ts";
import { getViews } from "../../api.ts";

const EMPTY: ViewList = { version: 0, views: [], errors: [] };

let current: ViewList = EMPTY;
let fetched = false;
let latest = 0;
const listeners = new Set<() => void>();

/**
 * Fetches the project's views again — on `views-changed`, and whenever the
 * event stream reconnects.
 */
export function refetchViews(): void {
  fetched = true;
  const request = ++latest;
  getViews()
    .then(list => {
      if (request !== latest) return;
      current = list;
      for (const listener of listeners) listener();
    })
    .catch(() => {
      /* none: no view tabs */
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The project's views, fetched on first use and kept current. */
export function useViewList(): ViewList {
  useEffect(() => {
    if (!fetched) refetchViews();
  }, []);
  return useSyncExternalStore(subscribe, () => current);
}
