// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpTraceSink, type TraceEventsRequest } from "./http-trace-sink.ts";
import type { Span } from "./trace-types.ts";

const span = (id: string): Span => ({
  id,
  traceId: "t",
  name: id,
  kind: "DEFAULT",
  startTime: 1,
});

/** A `fetch` that records each request it's given and answers `status`. */
function recordingFetch(status = 200) {
  const requests: { url: string; body: TraceEventsRequest }[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status });
    },
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpTraceSink", () => {
  it("posts events recorded in quick succession as one batch, under the endpoint", async () => {
    const { fetch, requests } = recordingFetch();
    const sink = new HttpTraceSink({ endpoint: "http://host:3000/", fetch });

    await sink.recordSpanStart(span("a"));
    await sink.recordSpanEnd(span("a"));
    await sink.failTrace("t", "boom");
    await sink.flush();

    expect(requests).toEqual([
      {
        url: "http://host:3000/api/traces",
        body: {
          events: [
            { type: "span-start", span: span("a") },
            { type: "span-end", span: span("a") },
            { type: "trace-fail", traceId: "t", errorMessage: "boom" },
          ],
        },
      },
    ]);
  });

  it("returns before the request is answered, and sends later events after it", async () => {
    let answer!: () => void;
    const bodies: TraceEventsRequest[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        await new Promise<void>(resolve => {
          answer = resolve;
        });
      }
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const sink = new HttpTraceSink({ endpoint: "http://host", fetch });

    await sink.recordSpanStart(span("a"));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    // The first request is still in flight: these wait for it.
    await sink.recordSpanStart(span("b"));
    await sink.recordSpanEnd(span("b"));
    expect(bodies).toHaveLength(1);

    answer();
    await sink.flush();
    expect(bodies.map(b => b.events.map(e => e.type))).toEqual([
      ["span-start"],
      ["span-start", "span-end"],
    ]);
  });

  it("drops a batch the server rejects, warning once until one succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let status = 500;
    const fetch = vi.fn(
      async () => new Response("nope", { status }),
    ) as unknown as typeof globalThis.fetch;
    const sink = new HttpTraceSink({ endpoint: "http://host", fetch });

    await sink.recordSpanStart(span("a"));
    await sink.flush();
    await sink.recordSpanStart(span("b"));
    await sink.flush();
    expect(warn).toHaveBeenCalledTimes(1);

    status = 200;
    await sink.recordSpanStart(span("c"));
    await sink.flush();
    status = 500;
    await sink.recordSpanStart(span("d"));
    await sink.flush();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("flush resolves at once with nothing to send", async () => {
    const { fetch, requests } = recordingFetch();
    const sink = new HttpTraceSink({ endpoint: "http://host", fetch });

    await sink.flush();
    expect(requests).toEqual([]);
  });

  it("survives a fetch that throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const sink = new HttpTraceSink({ endpoint: "http://host", fetch });

    await expect(sink.recordSpanStart(span("a"))).resolves.toEqual(span("a"));
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  describe("with a lazy endpoint", () => {
    it("holds events until it resolves, and resolves once", async () => {
      const { fetch, requests } = recordingFetch();
      let resolve!: (target: { endpoint: string }) => void;
      const endpoint = vi.fn(
        () =>
          new Promise<{ endpoint: string }>(r => {
            resolve = r;
          }),
      );
      const sink = new HttpTraceSink({ endpoint, fetch });

      expect(endpoint).not.toHaveBeenCalled();
      await sink.recordSpanStart(span("a"));
      await vi.waitFor(() => expect(endpoint).toHaveBeenCalledTimes(1));
      await sink.recordSpanEnd(span("a"));
      expect(requests).toEqual([]);

      resolve({ endpoint: "http://late" });
      await sink.flush();
      await sink.recordSpanStart(span("b"));
      await sink.flush();

      expect(endpoint).toHaveBeenCalledTimes(1);
      expect(requests.map(r => r.url)).toEqual([
        "http://late/api/traces",
        "http://late/api/traces",
      ]);
      expect(requests[0].body.events).toHaveLength(2);
    });

    it("uses the target's own headers and fetch", async () => {
      const unused = recordingFetch();
      const fetch = vi.fn(
        async (_url: unknown, _init?: RequestInit) => new Response("{}"),
      );
      const sink = new HttpTraceSink({
        endpoint: async () => ({
          endpoint: "http://host",
          headers: { authorization: "Bearer k" },
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
        fetch: unused.fetch,
      });

      await sink.recordSpanStart(span("a"));
      await sink.flush();

      expect(unused.requests).toEqual([]);
      expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
        authorization: "Bearer k",
      });
    });

    it.each([
      ["finds nowhere", async () => undefined],
      [
        "throws",
        async () => {
          throw new Error("no");
        },
      ],
    ])("drops everything when it %s", async (_name, endpoint) => {
      const { fetch, requests } = recordingFetch();
      const lookup = vi.fn(endpoint);
      const sink = new HttpTraceSink({ endpoint: lookup, fetch });

      await sink.recordSpanStart(span("a"));
      await sink.flush();
      await sink.recordSpanStart(span("b"));
      await sink.flush();

      expect(requests).toEqual([]);
      expect(lookup).toHaveBeenCalledTimes(1);
    });
  });
});
