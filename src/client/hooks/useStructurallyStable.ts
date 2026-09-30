// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useRef } from "react";

/**
 * `value`, or the one from the last render while it's JSON-equal to it — so
 * something recomputed each render (the sources a panel offers, say) keeps
 * its identity until its content actually changes. Editors that are rebuilt
 * when their props' identity changes would otherwise remount, dropping focus
 * mid-typing.
 */
export function useStructurallyStable<T>(value: T): T {
  const last = useRef<{ value: T; json: string } | null>(null);
  const json = JSON.stringify(value) ?? "";
  if (last.current?.json !== json) last.current = { value, json };
  return last.current.value;
}
