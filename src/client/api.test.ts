// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it, vi } from "vitest";
import { addDatasetField, createEmptyDataset, getTrace } from "./api.ts";

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

describe("createEmptyDataset", () => {
  it("creates a dataset with no fields and no prompt on the first provider", async () => {
    const created = {
      id: "scratch",
      name: "Scratch",
      fields: [],
      createdAt: 5,
      updatedAt: 5,
    };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url === "/api/dataset-providers"
        ? jsonResponse([{ id: "local" }, { id: "remote" }], 200)
        : jsonResponse(created, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createEmptyDataset("Scratch")).resolves.toEqual({
      providerId: "local",
      id: "scratch",
      name: "Scratch",
      rowCount: 0,
      fields: [],
      updatedAt: 5,
    });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/datasets/local");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Scratch",
      fields: [],
    });
  });

  it("fails without creating anything when no dataset provider is configured", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([], 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createEmptyDataset("Scratch")).rejects.toThrow(
      "No dataset provider is configured",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("addDatasetField", () => {
  it("posts the request to the dataset's fields route", async () => {
    const field = { id: "2", def: { name: "expectedTitle" } };
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(field, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = { name: "expectedTitle", type: "string" } as const;
    expect(await addDatasetField("local", "odin tasks", request)).toEqual(
      field,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/datasets/local/odin%20tasks/fields");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it("rejects with the server's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "`title: string` already exists" }, 400),
      ),
    );
    await expect(
      addDatasetField("local", "d", { name: "title", type: "string" }),
    ).rejects.toThrow("`title: string` already exists");
  });
});
