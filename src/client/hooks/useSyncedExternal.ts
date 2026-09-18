// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useRef, useState } from "react";

function syncKey(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Mirrors an external value into local state so it can be edited freely,
 * resyncing only when the external value structurally changes (not on every
 * parent re-render). Without the structural compare, an in-flight edit can be
 * stomped when the parent re-renders with a fresh-but-equal object reference
 * after a debounced save round-trips.
 *
 * Local edits are treated as authoritative until an external value arrives with
 * the same structural key. While sync is paused, matching external values only
 * acknowledge the local edit; they do not rewrite local state. That avoids
 * touching a focused contentEditable during save round-trips, including the
 * narrow timing window before the browser's input event has updated React state.
 */
export function useSyncedExternal<T>(
  external: T,
  syncVersion = 0,
  syncPausedRef?: { current: boolean },
): [T, (v: T) => void] {
  const [local, setLocal] = useState(external);
  const initialKey = syncKey(external);
  const lastExternalKey = useRef(initialKey);
  const localKey = useRef(initialKey);
  const dirty = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: syncVersion intentionally retries the sync after focus leaves.
  useEffect(() => {
    const key = syncKey(external);
    if (key === lastExternalKey.current) return;

    if (syncPausedRef?.current) {
      if (key === localKey.current) {
        lastExternalKey.current = key;
        dirty.current = false;
      }
      return;
    }

    if (dirty.current) {
      if (key === localKey.current) {
        lastExternalKey.current = key;
        dirty.current = false;
      }
      return;
    }

    if (key !== lastExternalKey.current) {
      lastExternalKey.current = key;
      localKey.current = key;
      setLocal(external);
    }
  }, [external, syncVersion, syncPausedRef]);

  const setLocalValue = useCallback((next: T) => {
    const key = syncKey(next);
    localKey.current = key;
    dirty.current = key !== lastExternalKey.current;
    setLocal(next);
  }, []);

  return [local, setLocalValue];
}
