// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Span, TraceLiveEvent } from "../../shared/types.ts";
import type { TraceProvider } from "../../trace/trace-provider.ts";

/**
 * The minimal SSE-writing surface this handler needs — satisfied structurally
 * by Hono's `hono/streaming` `streamSSE` callback argument, but not typed
 * against it directly, so this stays a plain host-neutral handler (testable
 * with a fake writer, no Hono import).
 */
export interface SSEWriter {
  writeSSE(message: { data: string }): Promise<void>;
  onAbort(callback: () => void): void;
}

export interface TraceStreamDeps {
  provider: TraceProvider;
  traceId: string;
  /**
   * Maps a span's prompt reference (which may be a global id) to a concrete,
   * provider-scoped one the client can open. Injected rather than imported,
   * so this handler doesn't need to know about the prompt registry.
   */
  resolveSpanPrompt: (span: Span) => Span;
}

/**
 * Streams live updates for one trace over SSE: replays its current state
 * (spans, then annotations) so a late subscriber isn't stuck waiting for the
 * next event before it can render anything, then forwards
 * `provider.subscribeTrace` and `provider.subscribeAnnotations` — broadened
 * into the single {@link TraceLiveEvent} union so annotations ride the same
 * connection a trace view already holds open. See
 * `specs/trace-workshopping.md` §C.1.
 */
export async function streamTrace(
  stream: SSEWriter,
  { provider, traceId, resolveSpanPrompt }: TraceStreamDeps,
): Promise<void> {
  const send = (event: TraceLiveEvent) =>
    stream.writeSSE({ data: JSON.stringify(event) });

  // Not a `TraceLiveEvent` — a connection-level sentinel, same shape as the
  // hot-reload stream's, so the client knows the SSE connection is live.
  await stream.writeSSE({ data: JSON.stringify({ type: "connected" }) });

  const resolveEvent = (event: TraceLiveEvent): TraceLiveEvent =>
    "span" in event ? { ...event, span: resolveSpanPrompt(event.span) } : event;

  // Replay existing state so late subscribers aren't stuck waiting for the
  // next event before they can render anything.
  const existing = await provider.getTrace(traceId);
  if (existing) {
    for (const span of existing.spans) {
      const resolved = resolveSpanPrompt(span);
      await send(
        resolved.endTime === undefined
          ? { type: "span-start", span: resolved }
          : { type: "span-end", span: resolved },
      );
    }
  }
  const existingAnnotations = await provider.listAnnotations?.(traceId);
  if (existingAnnotations) {
    for (const annotation of existingAnnotations) {
      await send({ type: "annotation", op: "insert", annotation });
    }
  }

  const unsubscribeTrace = provider.subscribeTrace?.(
    traceId,
    event => void send(resolveEvent(event)),
  );
  const unsubscribeAnnotations = provider.subscribeAnnotations?.(
    traceId,
    event => void send(event),
  );

  await new Promise<void>(resolve => {
    stream.onAbort(() => {
      unsubscribeTrace?.();
      unsubscribeAnnotations?.();
      resolve();
    });
  });
}
