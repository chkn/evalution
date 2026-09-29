// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** A value mirrored to `localStorage`, shared live across every reader in this tab. */
export interface PersistentValue<T> {
  get(): T;
  set(next: T): void;
  /** @returns An unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * A `localStorage`-backed value every reader in this tab sees updated at
 * once — unlike `localStorage` itself, whose `storage` event only fires in
 * *other* tabs, leaving same-tab readers (e.g. two open prompt tabs) stale
 * until they happen to remount.
 */
export function createPersistentValue<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T,
): PersistentValue<T> {
  function read(): T {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : parse(raw);
    } catch {
      return fallback;
    }
  }

  let value = read();
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set(next) {
      value = next;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Private mode: the preference lasts for this page only.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
