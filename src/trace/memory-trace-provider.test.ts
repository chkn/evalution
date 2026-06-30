// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { Span, TraceStreamEvent } from "../shared/types.ts";
import { MemoryTraceProvider } from "./memory-trace-provider.ts";
import type { TraceSink } from "./trace-sink.ts";

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

describe("MemoryTraceProvider", () => {
  it("recordSpanStart creates a running trace for a new root span", async () => {
    const provider = new MemoryTraceProvider();
    const span = rootSpan("t1");

    await provider.recordSpanStart(span);

    const loaded = await provider.getTrace("t1");
    expect(loaded?.trace.status).toBe("running");
    expect(loaded?.trace.name).toBe("root");
    expect(loaded?.spans).toHaveLength(1);
  });

  it("recordSpanEnd finalizes the trace as ok, or error when the span errored", async () => {
    const provider = new MemoryTraceProvider();
    const span = rootSpan("t1");
    await provider.recordSpanStart(span);

    await provider.recordSpanEnd({
      ...span,
      endTime: Date.now(),
      status: "ok",
    });
    expect((await provider.getTrace("t1"))?.trace.status).toBe("ok");

    const errProvider = new MemoryTraceProvider();
    const errSpan = rootSpan("t2");
    await errProvider.recordSpanStart(errSpan);
    await errProvider.recordSpanEnd({
      ...errSpan,
      endTime: Date.now(),
      status: "error",
      errorMessage: "boom",
    });
    const loaded = await errProvider.getTrace("t2");
    expect(loaded?.trace.status).toBe("error");
    expect(loaded?.spans[0].errorMessage).toBe("boom");
  });

  it("merges a span's end snapshot into its start snapshot rather than replacing it", async () => {
    const provider = new MemoryTraceProvider();
    const span = rootSpan("t1", { attributes: { "at.start": "a" } });
    await provider.recordSpanStart(span);
    await provider.recordSpanEnd({
      ...span,
      attributes: { "at.end": "b" },
      endTime: Date.now(),
      status: "ok",
    });

    const loaded = await provider.getTrace("t1");
    expect(loaded?.spans[0].attributes).toEqual({
      "at.start": "a",
      "at.end": "b",
    });
  });

  it("does not create a trace for a non-root span", async () => {
    const provider = new MemoryTraceProvider();
    const child = rootSpan("t1", { id: "t1:child", parentId: "t1:root" });
    await provider.recordSpanStart(child);

    expect(await provider.hasTrace("t1")).toBe(false);
  });

  it("failTrace finalizes a running trace as error", async () => {
    const provider = new MemoryTraceProvider();
    await provider.recordSpanStart(rootSpan("t1"));

    await provider.failTrace("t1", "bad model id");

    const loaded = await provider.getTrace("t1");
    expect(loaded?.trace.status).toBe("error");
    expect(loaded?.trace.attributes?.errorMessage).toBe("bad model id");
  });

  it("failTrace on an unknown trace id is a no-op", async () => {
    const provider = new MemoryTraceProvider();
    await expect(
      provider.failTrace("unknown", "boom"),
    ).resolves.toBeUndefined();
    expect(await provider.hasTrace("unknown")).toBe(false);
  });

  it("streams span-start, span-end and trace-end events in order", async () => {
    const provider = new MemoryTraceProvider();
    const span = rootSpan("t1");

    const events: TraceStreamEvent[] = [];
    provider.subscribeTrace("t1", e => events.push(e));

    await provider.recordSpanStart(span);
    await provider.recordSpanEnd({
      ...span,
      endTime: Date.now(),
      status: "ok",
    });

    expect(events.map(e => e.type)).toEqual([
      "span-start",
      "span-end",
      "trace-end",
    ]);
  });

  it("getAllTraces lists traces newest-first", async () => {
    const provider = new MemoryTraceProvider();
    await provider.recordSpanStart(rootSpan("a", { startTime: 1 }));
    await provider.recordSpanStart(rootSpan("b", { startTime: 2 }));

    const summaries = await provider.getAllTraces();
    expect(summaries.map(s => s.id)).toEqual(["b", "a"]);
  });

  it("notifies watchers on add and update", async () => {
    const provider = new MemoryTraceProvider();
    const seen: string[] = [];
    provider.watch(e => seen.push(`${e.type}:${e.traceId}`));

    const span = rootSpan("t1");
    await provider.recordSpanStart(span);
    await provider.recordSpanEnd({
      ...span,
      endTime: Date.now(),
      status: "ok",
    });

    expect(seen).toContain("add:t1");
    expect(seen).toContain("update:t1");
  });

  it("connects ingestors passed at construction time as sinks", async () => {
    const sinksCalled: TraceSink[] = [];
    const ingestor = {
      addSink: (sink: TraceSink) => sinksCalled.push(sink),
      removeSink: () => false,
    };
    const mtp = new MemoryTraceProvider({ id: "mem1", ingestors: [ingestor] });

    expect(sinksCalled).toEqual([mtp]);
  });
});
