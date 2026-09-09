// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The `BaseTraceProvider` contract, as a reusable vitest suite. Both
 * `memory-trace-provider.test.ts` and `turso-trace-provider.test.ts` run this
 * against their own provider — same behavior, different storage. See
 * `specs/trace-workshopping.md` "Verification" ("Provider parity").
 */

import { afterAll, describe, expect, it } from "vitest";
import type { TraceIngestor } from "./trace-ingestor.ts";
import type { TraceSink } from "./trace-sink.ts";
import type { Span, TraceStreamEvent } from "./trace-types.ts";

/** Minimal surface every `BaseTraceProvider` subclass exposes. */
export interface ContractProvider extends TraceSink {
  id: string;
  getTrace(traceId: string): Promise<{ trace: { status: string } } | undefined>;
  hasTrace(traceId: string): Promise<boolean>;
  getAllTraces(): Promise<{ id: string }[]>;
  subscribeTrace(
    traceId: string,
    callback: (event: TraceStreamEvent) => void,
  ): () => void;
  watch(
    callback: (event: { type: string; traceId: string }) => void,
  ): () => void;
}

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
 * Runs the full `BaseTraceProvider` contract suite under `describe(name, …)`.
 * `makeProvider` mints a fresh, independent provider on every call (some
 * tests need more than one), and `cleanup` (if given) runs once after all of
 * this suite's tests finish — for a storage backend with real resources to
 * release (e.g. `TursoTraceProvider`'s temp-dir-backed clients).
 */
export function runTraceProviderContractTests(
  name: string,
  makeProvider: (opts?: {
    id?: string;
    ingestors?: TraceIngestor[];
  }) => Promise<ContractProvider>,
  cleanup?: () => Promise<void>,
) {
  describe(name, () => {
    if (cleanup) afterAll(cleanup);

    it("recordSpanStart creates a running trace for a new root span", async () => {
      const provider = await makeProvider();
      const span = rootSpan("t1");

      await provider.recordSpanStart(span);

      const loaded = await provider.getTrace("t1");
      expect(loaded?.trace.status).toBe("running");
      expect((loaded as any)?.trace.name).toBe("root");
      expect((loaded as any)?.spans).toHaveLength(1);
    });

    it("recordSpanEnd finalizes the trace as ok, or error when the span errored", async () => {
      const provider = await makeProvider();
      const span = rootSpan("t1");
      await provider.recordSpanStart(span);

      await provider.recordSpanEnd({
        ...span,
        endTime: Date.now(),
        status: "ok",
      });
      expect((await provider.getTrace("t1"))?.trace.status).toBe("ok");

      const errProvider = await makeProvider();
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
      expect((loaded as any)?.spans[0].errorMessage).toBe("boom");
    });

    it("merges a span's end snapshot into its start snapshot rather than replacing it", async () => {
      const provider = await makeProvider();
      const span = rootSpan("t1", { attributes: { "at.start": "a" } });
      await provider.recordSpanStart(span);
      await provider.recordSpanEnd({
        ...span,
        attributes: { "at.end": "b" },
        endTime: Date.now(),
        status: "ok",
      });

      const loaded = await provider.getTrace("t1");
      expect((loaded as any)?.spans[0].attributes).toEqual({
        "at.start": "a",
        "at.end": "b",
      });
    });

    it("does not create a trace for a non-root span", async () => {
      const provider = await makeProvider();
      const child = rootSpan("t1", { id: "t1:child", parentId: "t1:root" });
      await provider.recordSpanStart(child);

      expect(await provider.hasTrace("t1")).toBe(false);
    });

    it("failTrace finalizes a running trace as error", async () => {
      const provider = await makeProvider();
      await provider.recordSpanStart(rootSpan("t1"));

      await provider.failTrace("t1", "bad model id");

      const loaded = await provider.getTrace("t1");
      expect(loaded?.trace.status).toBe("error");
      expect((loaded as any)?.trace.attributes?.errorMessage).toBe(
        "bad model id",
      );
    });

    it("failTrace on an unknown trace id is a no-op", async () => {
      const provider = await makeProvider();
      await expect(
        provider.failTrace("unknown", "boom"),
      ).resolves.toBeUndefined();
      expect(await provider.hasTrace("unknown")).toBe(false);
    });

    it("streams span-start, span-end and trace-end events in order", async () => {
      const provider = await makeProvider();
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
      const provider = await makeProvider();
      await provider.recordSpanStart(rootSpan("a", { startTime: 1 }));
      await provider.recordSpanStart(rootSpan("b", { startTime: 2 }));

      const summaries = await provider.getAllTraces();
      expect(summaries.map(s => s.id)).toEqual(["b", "a"]);
    });

    it("notifies watchers on add and update", async () => {
      const provider = await makeProvider();
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

    it("records concurrently-started sibling spans", async () => {
      // `BaseTraceIngestor` fans a span out to its sinks with `Promise.all`,
      // and `OTelTraceIngestor`'s `onStart`/`onEnd` are fire-and-forget per
      // span, so any two spans starting in the same tick arrive here
      // concurrently — a storage backend on a single connection has to
      // serialize them rather than overlap two transactions.
      const provider = await makeProvider();
      const root = rootSpan("t1");
      await provider.recordSpanStart(root);

      await Promise.all(
        ["a", "b", "c"].map(id =>
          provider.recordSpanStart(
            rootSpan("t1", { id, parentId: root.id, name: id }),
          ),
        ),
      );

      const loaded = await provider.getTrace("t1");
      expect((loaded as any)?.spans).toHaveLength(4);
    });

    it("connects ingestors passed at construction time as sinks", async () => {
      const sinksCalled: TraceSink[] = [];
      const ingestor: TraceIngestor = {
        addSink: (sink: TraceSink) => sinksCalled.push(sink),
        removeSink: () => false,
      };
      const provider = await makeProvider({
        id: "custom-id",
        ingestors: [ingestor],
      });

      expect(sinksCalled).toEqual([provider]);
    });
  });
}
