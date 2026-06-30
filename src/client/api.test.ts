// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it, vi } from "vitest";
import { getTrace } from "./api.ts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getTrace", () => {
  it("reports an error when a trace is opened before it is started on the server", async () => {
    // The trace is auto-opened (right after execute returns its id) but never
    // gets created on the server — `GET` keeps 404ing. Polling must give up at
    // the deadline and surface the server error rather than hang forever.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "Trace not found" }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getTrace("memory", "missing", { timeoutMs: 30, intervalMs: 5 }),
    ).rejects.toThrow("Trace not found");
    // It polled rather than failing on the first 404.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("waits and polls until the trace is created, then resolves", async () => {
    const trace = {
      trace: { id: "t1", name: "x", startTime: 0, status: "running" },
      spans: [],
    };
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls < 3
        ? jsonResponse({ error: "Trace not found" }, 404)
        : jsonResponse(trace, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTrace("memory", "t1", {
      timeoutMs: 1000,
      intervalMs: 1,
    });
    expect(result).toEqual(trace);
    expect(calls).toBe(3);
  });

  it("throws immediately on a non-404 error without polling", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getTrace("memory", "t1", { timeoutMs: 1000, intervalMs: 5 }),
    ).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the signal is aborted", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "Trace not found" }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const promise = getTrace("memory", "t1", {
      signal: controller.signal,
      intervalMs: 50,
    });
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
  });
});
