// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Evals created in this session and not yet opened, so the editor pre-fills
 * a new eval's bindings once (`specs/evals.md` §F.1) and never again when
 * it's opened later. Held in memory only.
 */

const fresh = new Set<string>();
const keyOf = (providerId: string, evalId: string) =>
  JSON.stringify([providerId, evalId]);

/** Records that the eval was just created. */
export function markFreshEval(providerId: string, evalId: string): void {
  fresh.add(keyOf(providerId, evalId));
}

/** Whether the eval was just created, forgetting it so it's asked once. */
export function takeFreshEval(providerId: string, evalId: string): boolean {
  return fresh.delete(keyOf(providerId, evalId));
}
