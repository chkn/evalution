// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ChangeEventType } from "../shared/types.ts";

/**
 * Tracks prompt edits this client just made so it can ignore the matching
 * `prompt-changed` SSE echo. A mutating request (update/rename/add) already
 * returns the new prompt and patches local state, so re-fetching on its own
 * echo is redundant — and disruptive, as it resets editor cursor position.
 *
 * This lives on the client (rather than suppressing the watcher on the server)
 * so it works when several clients share one workspace: each client ignores
 * only *its own* edits' echoes and still reacts to everyone else's.
 *
 * Echoes can race ahead of or behind the request's response, so entries carry a
 * short TTL and a count (rapid edits to the same prompt queue multiple echoes).
 */
interface PendingEcho {
  remaining: number;
  expiresAt: number;
}

const pending = new Map<string, PendingEcho>();
const ECHO_TTL_MS = 2000;

function key(
  eventType: ChangeEventType,
  providerId: string,
  promptId: string,
): string {
  return `${eventType}:${providerId}:${promptId}`;
}

/** Record that this client caused an upcoming `eventType` change to `promptId`. */
export function markSelfEdit(
  eventType: ChangeEventType,
  providerId: string,
  promptId: string,
): void {
  const k = key(eventType, providerId, promptId);
  const entry = pending.get(k);
  pending.set(k, {
    remaining: (entry?.remaining ?? 0) + 1,
    expiresAt: Date.now() + ECHO_TTL_MS,
  });
}

/**
 * Returns `true` if the given change event was caused by this client (and
 * consumes the record), meaning the caller should skip re-fetching.
 */
export function consumeSelfEdit(
  eventType: ChangeEventType,
  providerId: string,
  promptId: string,
): boolean {
  const k = key(eventType, providerId, promptId);
  const entry = pending.get(k);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    pending.delete(k);
    return false;
  }
  if (entry.remaining <= 1) pending.delete(k);
  else pending.set(k, { remaining: entry.remaining - 1, expiresAt: entry.expiresAt });
  return true;
}
