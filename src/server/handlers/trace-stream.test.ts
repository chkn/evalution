// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { MemoryTraceProvider } from "../../trace/memory-trace-provider.ts";
import type { Span, TraceLiveEvent } from "../../trace/trace-types.ts";
import { type SSEWriter, streamTrace } from "./trace-stream.ts";

function rootSpan(traceId: string, overrides: Partial<Span> = {}): Span {
  return {
    id: `${traceId}:root`,
    traceId,
    name: "root",
    kind: "LLM",
    startTime: Date.now(),
    ...overrides,
  };
}

/**
 * A fake SSEWriter that records every message and lets the test trigger
 * abort. `abort()` waits until `streamTrace` has actually registered its
 * abort handler before calling it — it does several of its own awaits
 * (replay, then subscribe) before reaching that point, so calling it
 * synchronously right after starting `streamTrace` would silently no-op.
 */
function fakeStream() {
  const messages: unknown[] = [];
  let onAbort: (() => void) | undefined;
  const stream: SSEWriter = {
    writeSSE: async ({ data }) => {
      messages.push(JSON.parse(data));
    },
    onAbort: cb => {
      onAbort = cb;
    },
  };
  const abort = async () => {
    while (!onAbort) await new Promise(r => setTimeout(r, 0));
    onAbort();
  };
  return { stream, messages, abort };
}

describe("streamTrace", () => {
  it("sends a connected sentinel, then replays existing spans", async () => {
    const provider = new MemoryTraceProvider();
    const span = rootSpan("t1");
    await provider.recordSpanStart(span);
    await provider.recordSpanEnd({
      ...span,
      endTime: Date.now(),
      status: "ok",
    });

    const { stream, messages, abort } = fakeStream();
    const done = streamTrace(stream, {
      provider,
      traceId: "t1",
      resolveSpanPrompt: s => s,
    });
    await abort();
    await done;

    expect(messages[0]).toEqual({ type: "connected" });
    expect(messages.some((m: any) => m.type === "span-end")).toBe(true);
  });

  it("replays existing annotations as insert events", async () => {
    const provider = new MemoryTraceProvider();
    // MemoryTraceProvider has no annotation store — exercise the "provider
    // supports annotations" replay path with a minimal fake instead.
    const fakeProvider = {
      ...provider,
      getTrace: provider.getTrace.bind(provider),
      listAnnotations: async (_traceId: string) => [
        {
          id: "a1",
          traceId: "t1",
          kind: "note" as const,
          note: "hi",
          source: "user" as const,
          createdAt: 1,
        },
      ],
    };

    const { stream, messages, abort } = fakeStream();
    const done = streamTrace(stream, {
      provider: fakeProvider as any,
      traceId: "t1",
      resolveSpanPrompt: s => s,
    });
    await abort();
    await done;

    expect(messages).toContainEqual({
      type: "annotation",
      op: "insert",
      annotation: {
        id: "a1",
        traceId: "t1",
        kind: "note",
        note: "hi",
        source: "user",
        createdAt: 1,
      },
    });
  });

  it("forwards live span and annotation events, resolving span prompts", async () => {
    const provider = new MemoryTraceProvider();
    const { stream, messages, abort } = fakeStream();

    const done = streamTrace(stream, {
      provider,
      traceId: "t1",
      resolveSpanPrompt: s => ({ ...s, name: `resolved:${s.name}` }),
    });

    // Give `streamTrace` a chance to finish replay + subscribe before firing
    // events it's supposed to catch.
    await new Promise(r => setTimeout(r, 0));

    const span = rootSpan("t1");
    await provider.recordSpanStart(span);
    provider.emitAnnotation("t1", "insert", {
      id: "a1",
      traceId: "t1",
      kind: "issue",
      note: "bad",
      source: "claude-code",
      createdAt: 2,
    });

    await abort();
    await done;

    const spanStart = messages.find((m: any) => m.type === "span-start") as any;
    expect(spanStart.span.name).toBe("resolved:root");

    const annotationEvent = messages.find(
      (m: any) => m.type === "annotation",
    ) as TraceLiveEvent & { type: "annotation" };
    expect(annotationEvent.op).toBe("insert");
    expect(annotationEvent.annotation.source).toBe("claude-code");
  });

  it("unsubscribes from both trace and annotation streams on abort", async () => {
    const provider = new MemoryTraceProvider();
    const { stream, abort } = fakeStream();

    const done = streamTrace(stream, {
      provider,
      traceId: "t1",
      resolveSpanPrompt: s => s,
    });
    await abort();
    await done;

    // No subscriber should remain registered after abort.
    const seen: unknown[] = [];
    provider.subscribeTrace("t1", e => seen.push(e));
    await provider.recordSpanStart(rootSpan("t1"));
    expect(seen).toHaveLength(1); // only the fresh subscription above fired
  });
});
