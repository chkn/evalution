// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  ListTracesQuery,
  TraceChangeEvent,
  TraceSummary,
} from "@evalution/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CloudTraceClient,
  CloudTraceProvider,
} from "./cloud-trace-provider.ts";

function summary(id: string, fields: Partial<TraceSummary> = {}) {
  return {
    id,
    providerId: "whatever-the-cloud-says",
    name: id,
    startTime: 1,
    status: "running",
    spanCount: 1,
    ...fields,
  } as TraceSummary;
}

/** A client whose listing is whatever `traces` holds when it's called. */
function fakeClient(initial: TraceSummary[] = []) {
  const state = { traces: initial, fail: false };
  const queries: ListTracesQuery[] = [];
  const client: CloudTraceClient = {
    listTraces: vi.fn(async (query?: ListTracesQuery) => {
      queries.push(query ?? {});
      if (state.fail) throw new Error("offline");
      return state.traces;
    }),
    getTrace: vi.fn(async (id: string) =>
      id === "t1"
        ? {
            trace: { id, name: "t1", startTime: 1, status: "ok" as const },
            spans: [],
          }
        : undefined,
    ),
  };
  return { client, state, queries };
}

const quiet = { warn: vi.fn() };

describe("CloudTraceProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    quiet.warn.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the recent traces of the window as its own", async () => {
    vi.setSystemTime(10_000_000);
    const { client, queries } = fakeClient([summary("t1")]);
    const provider = new CloudTraceProvider({
      client,
      windowMs: 1000,
      limit: 5,
      environment: "production",
    });

    const traces = await provider.getAllTraces();

    expect(traces).toEqual([
      expect.objectContaining({
        id: "t1",
        providerId: "cloud",
        annotationCounts: { issue: 0, good: 0, note: 0 },
      }),
    ]);
    expect(queries).toEqual([
      { environment: "production", from: 10_000_000 - 1000, limit: 5 },
    ]);
  });

  it("reads a trace as its own", async () => {
    const provider = new CloudTraceProvider({ client: fakeClient().client });
    expect((await provider.getTrace("t1"))?.trace.providerId).toBe("cloud");
    expect(await provider.getTrace("nope")).toBeUndefined();
  });

  it("shows the last listing while the cloud can't be reached, warning once", async () => {
    const { client, state } = fakeClient([summary("t1")]);
    const provider = new CloudTraceProvider({ client, log: quiet });
    await provider.getAllTraces();

    state.fail = true;
    expect((await provider.getAllTraces()).map(t => t.id)).toEqual(["t1"]);
    await provider.getAllTraces();
    expect(quiet.warn).toHaveBeenCalledTimes(1);

    // And warns again once it's failed anew after recovering.
    state.fail = false;
    await provider.getAllTraces();
    state.fail = true;
    await provider.getAllTraces();
    expect(quiet.warn).toHaveBeenCalledTimes(2);
  });

  it("polls while watched, reporting what changed", async () => {
    const { client, state } = fakeClient([summary("t1"), summary("t2")]);
    const provider = new CloudTraceProvider({
      client,
      pollIntervalMs: 1000,
    });
    const events: TraceChangeEvent[] = [];
    const unwatch = provider.watch(e => events.push(e));

    // The first poll is what the watcher starts from, not news.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listTraces).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    state.traces = [summary("t3"), summary("t1", { status: "ok", endTime: 2 })];
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([
      { type: "add", traceId: "t3" },
      { type: "update", traceId: "t1" },
      { type: "remove", traceId: "t2" },
    ]);

    // Nothing new, nothing reported.
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(3);

    unwatch();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.listTraces).toHaveBeenCalledTimes(3);
  });

  it("keeps polling through a failure", async () => {
    const { client, state } = fakeClient([summary("t1")]);
    const provider = new CloudTraceProvider({
      client,
      pollIntervalMs: 1000,
      log: quiet,
    });
    const events: TraceChangeEvent[] = [];
    provider.watch(e => events.push(e));
    await vi.advanceTimersByTimeAsync(0);

    state.fail = true;
    await vi.advanceTimersByTimeAsync(1000);
    state.fail = false;
    state.traces = [summary("t1"), summary("t2")];
    await vi.advanceTimersByTimeAsync(1000);

    expect(events).toEqual([{ type: "add", traceId: "t2" }]);
  });
});
