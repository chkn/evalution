// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useSyncExternalStore } from "react";
import type { PersistentValue } from "../persistent-value";

/** Reads and writes a {@link PersistentValue}, live across every component using it. */
export function usePersistentValue<T>(
  value: PersistentValue<T>,
): [T, (next: T) => void] {
  const current = useSyncExternalStore(value.subscribe, value.get);
  return [current, value.set];
}
