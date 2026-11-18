// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect } from "react";
import type { SSEData } from "../../shared/types.ts";

/** Backoff schedule for reopening a stream the browser gave up on, in ms. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** How long a tab stays hidden before its stream is closed, in ms. */
const HIDDEN_GRACE_MS = 60_000;

/** The document whose visibility {@link connectSSE} follows. */
export type VisibilitySource = EventTarget & {
  visibilityState: DocumentVisibilityState;
};

/** Handlers and test seams for {@link connectSSE}. */
export interface ConnectSSEOptions {
  /** Invoked for each parsed message. Malformed payloads are logged and skipped. */
  onMessage: (data: SSEData) => void;
  /** Invoked on the initial connection and on every reconnect. */
  onOpen?: () => void;
  /** Delays between reconnect attempts; the last one repeats. Exposed for tests. */
  retryDelaysMs?: number[];
  /** Defaults to the page's `document`, when there is one. Exposed for tests. */
  doc?: VisibilitySource;
  /** How long the tab stays hidden before the stream is closed, in ms. */
  hiddenGraceMs?: number;
}

/**
 * Opens `/api/events` and keeps it open, returning a function that closes it.
 *
 * An `EventSource` reconnects on its own after a dropped connection, but only
 * while the failure looks transient: a reconnect that gets an HTTP error
 * response — what the Vite dev proxy returns while the API server is down, and
 * what any proxy returns for a 5xx — puts it in `CLOSED` for good, per the
 * spec. Left alone, the page then goes silently stale: no `trace-changed`, no
 * `prompt-changed`, until someone reloads. So a closed stream is reopened here
 * on a backoff instead.
 *
 * A tab that stays hidden for `hiddenGraceMs` closes its stream, and opens it
 * again when it's shown, which refetches through `onOpen`. With no stream
 * open the server stops watching its trace providers, so a tab left in the
 * background doesn't keep `CloudTraceProvider` polling Evalution Cloud.
 */
export function connectSSE({
  onMessage,
  onOpen,
  retryDelaysMs = RETRY_DELAYS_MS,
  doc = typeof document === "undefined" ? undefined : document,
  hiddenGraceMs = HIDDEN_GRACE_MS,
}: ConnectSSEOptions): () => void {
  let eventSource: EventSource | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const open = () => {
    const es = new EventSource("/api/events");
    eventSource = es;

    es.onopen = () => {
      // The stream is live again, so the next drop starts its own backoff.
      attempt = 0;
      onOpen?.();
    };

    es.onmessage = event => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (err) {
        console.error("Failed to parse SSE message:", err);
      }
    };

    es.onerror = error => {
      // `CONNECTING` means the browser is retrying by itself; only a `CLOSED`
      // stream is one that never comes back without help.
      if (es.readyState !== EventSource.CLOSED) return;
      console.error("SSE connection closed; reconnecting:", error);
      scheduleReopen();
    };
  };

  /** Closes the stream, and any reopen pending, until {@link open} again. */
  const pause = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    attempt = 0;
    eventSource?.close();
    eventSource = undefined;
  };

  const onVisibility = () => {
    if (closed || !doc) return;
    if (doc.visibilityState === "hidden") {
      hiddenTimer ??= setTimeout(() => {
        hiddenTimer = undefined;
        pause();
      }, hiddenGraceMs);
      return;
    }
    if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
    if (!eventSource) open();
  };

  const scheduleReopen = () => {
    if (closed || retryTimer !== undefined) return;
    const delay =
      retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 1_000;
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (closed) return;
      eventSource?.close();
      open();
    }, delay);
  };

  if (doc?.visibilityState !== "hidden") open();
  doc?.addEventListener("visibilitychange", onVisibility);

  return () => {
    closed = true;
    doc?.removeEventListener("visibilitychange", onVisibility);
    if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
    pause();
  };
}

/**
 * Subscribes to the server's change events for the lifetime of the component.
 * See {@link connectSSE} for the reconnect behaviour.
 */
export function useSSE(
  onMessage: (data: SSEData) => void,
  onOpen?: () => void,
) {
  useEffect(() => connectSSE({ onMessage, onOpen }), [onMessage, onOpen]);
}
