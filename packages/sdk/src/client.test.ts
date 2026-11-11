// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyKind, Evalution, type EvalutionOptions } from "./client.ts";
import type { HttpTraceTarget } from "./http-trace-sink.ts";
import type { Span } from "./trace-types.ts";

const { discoverPortkit } = vi.hoisted(() => ({
  discoverPortkit: vi.fn(
    async (): Promise<HttpTraceTarget | undefined> => undefined,
  ),
}));
vi.mock("./portkit.ts", () => ({ discoverPortkit }));

const INGEST = "evl_ingest_abc";
const PERSONAL = "evl_user_abc";

const span: Span = {
  id: "s",
  traceId: "t",
  name: "s",
  kind: "DEFAULT",
  startTime: 1,
};

/** A `fetch` that records requests and answers `body` with `status`. */
function stubFetch(body: unknown = {}, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Where one span goes from a client built with `options`, and with what auth. */
async function destination(options: EvalutionOptions = {}) {
  const { fetch, calls } = stubFetch();
  const client = new Evalution({ ...options, fetch });
  await client.recordSpanStart(span);
  await client.flush();
  if (calls.length === 0) return undefined;
  const headers = calls[0].init.headers as Record<string, string>;
  return { url: calls[0].url, authorization: headers.authorization };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiKeyKind", () => {
  it("reads the kind from the prefix", () => {
    expect(apiKeyKind(INGEST)).toBe("ingest");
    expect(apiKeyKind(PERSONAL)).toBe("personal");
    expect(apiKeyKind("sk-other")).toBeUndefined();
  });
});

describe("where Evalution sends traces", () => {
  it("sends nowhere with nothing configured", async () => {
    expect(await destination()).toBeUndefined();
  });

  it("sends an ingest key's traces to the cloud, with the key", async () => {
    vi.stubEnv("EVALUTION_API_KEY", INGEST);

    expect(await destination()).toEqual({
      url: "https://api.evalut.io/api/traces",
      authorization: `Bearer ${INGEST}`,
    });
  });

  it("uses EVALUTION_API_URL for the cloud's base URL", async () => {
    vi.stubEnv("EVALUTION_API_KEY", INGEST);
    vi.stubEnv("EVALUTION_API_URL", "https://staging.example/");

    expect((await destination())?.url).toBe(
      "https://staging.example/api/traces",
    );
  });

  it("prefers an ingest key over EVALUTION_ENDPOINT", async () => {
    vi.stubEnv("EVALUTION_API_KEY", INGEST);
    vi.stubEnv("EVALUTION_ENDPOINT", "http://localhost:3000");

    expect((await destination())?.url).toBe("https://api.evalut.io/api/traces");
  });

  it("sends to EVALUTION_ENDPOINT without auth", async () => {
    vi.stubEnv("EVALUTION_ENDPOINT", "http://localhost:3000");

    expect(await destination()).toEqual({
      url: "http://localhost:3000/api/traces",
      authorization: undefined,
    });
  });

  it("never sends a personal key's traces to the cloud, or the key anywhere", async () => {
    vi.stubEnv("EVALUTION_API_KEY", PERSONAL);
    expect(await destination()).toBeUndefined();

    vi.stubEnv("EVALUTION_ENDPOINT", "http://localhost:3000");
    expect(await destination()).toEqual({
      url: "http://localhost:3000/api/traces",
      authorization: undefined,
    });
  });

  it("lets an explicit endpoint win, without sending the key", async () => {
    vi.stubEnv("EVALUTION_API_KEY", INGEST);

    expect(await destination({ endpoint: "http://other" })).toEqual({
      url: "http://other/api/traces",
      authorization: undefined,
    });
  });

  it("sends nowhere with endpoint: false, whatever the environment says", async () => {
    vi.stubEnv("EVALUTION_API_KEY", INGEST);
    vi.stubEnv("EVALUTION_ENDPOINT", "http://localhost:3000");

    expect(await destination({ endpoint: false })).toBeUndefined();
  });

  it("lets an explicit personal key override an ingest key in the environment", async () => {
    vi.stubEnv("EVALUTION_API_KEY", INGEST);

    expect(await destination({ apiKey: PERSONAL })).toBeUndefined();
  });

  it("warns about a key of neither kind, and doesn't use it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await destination({ apiKey: "sk-other" })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("sk-other");
  });

  it.each([
    ["no key", undefined],
    ["a personal key", PERSONAL],
  ])("sends to the instance portkit finds with %s", async (_name, apiKey) => {
    discoverPortkit.mockResolvedValueOnce({
      endpoint: "https://app.evalution.localhost",
    });

    expect(await destination({ apiKey })).toEqual({
      url: "https://app.evalution.localhost/api/traces",
      authorization: undefined,
    });
  });

  it("doesn't look for portkit when EVALUTION_ENDPOINT is set", async () => {
    vi.stubEnv("EVALUTION_ENDPOINT", "http://localhost:3000");

    await destination();

    expect(discoverPortkit).not.toHaveBeenCalled();
  });

  it("makes no attempt to discover portkit off Node", async () => {
    vi.stubGlobal("process", { env: {} });

    expect(await destination()).toBeUndefined();
    expect(discoverPortkit).not.toHaveBeenCalled();
  });
});

describe("Evalution's cloud calls", () => {
  const cloud = (body?: unknown, status?: number) => {
    const { fetch, calls } = stubFetch(body, status);
    const client = new Evalution({
      apiKey: PERSONAL,
      project: "prj_1",
      fetch,
    });
    return { client, calls };
  };

  it("sends the key and the project", async () => {
    const { client, calls } = cloud([]);

    await expect(client.listTraces()).resolves.toEqual([]);

    expect(calls[0].url).toBe("https://api.evalut.io/api/traces");
    expect(calls[0].init).toMatchObject({
      method: "GET",
      headers: {
        authorization: `Bearer ${PERSONAL}`,
        "evalution-project": "prj_1",
      },
    });
  });

  it("passes only the filters it's given", async () => {
    const { client, calls } = cloud([]);

    await client.listTraces({
      environment: "prod",
      limit: 5,
      from: undefined,
    });

    expect(calls[0].url).toBe(
      "https://api.evalut.io/api/traces?environment=prod&limit=5",
    );
  });

  it("gets one trace, or undefined when there's none", async () => {
    const found = cloud({ trace: { id: "a/b" }, spans: [] });
    await expect(found.client.getTrace("a/b")).resolves.toMatchObject({
      spans: [],
    });
    expect(found.calls[0].url).toBe("https://api.evalut.io/api/traces/a%2Fb");

    await expect(
      cloud({}, 404).client.getTrace("missing"),
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      "registerInstance",
      "PUT",
      "/cloud/v1/instances",
      (c: Evalution) =>
        c.registerInstance({
          instanceKey: "k",
          label: "l",
          localUrl: "http://localhost:3000",
        }),
    ],
    [
      "heartbeatInstance",
      "POST",
      "/cloud/v1/instances/i/heartbeat",
      (c: Evalution) => c.heartbeatInstance("i"),
    ],
    [
      "endInstanceSession",
      "DELETE",
      "/cloud/v1/instances/i/session",
      (c: Evalution) => c.endInstanceSession("i"),
    ],
    [
      "getSyncDatabase",
      "POST",
      "/cloud/v1/sync/databases",
      (c: Evalution) => c.getSyncDatabase({ kind: "traces" }),
    ],
    [
      "listProjects",
      "GET",
      "/cloud/v1/projects",
      (c: Evalution) => c.listProjects(),
    ],
    [
      "createProject",
      "POST",
      "/cloud/v1/projects",
      (c: Evalution) => c.createProject({ name: "n" }),
    ],
    ["whoami", "GET", "/cloud/v1/whoami", (c: Evalution) => c.whoami()],
  ])("%s calls %s %s", async (_name, method, path, call) => {
    const { client, calls } = cloud();

    await call(client);

    expect(calls[0].url).toBe(`https://api.evalut.io${path}`);
    expect(calls[0].init.method).toBe(method);
  });

  it("rejects with the status when the cloud refuses", async () => {
    await expect(cloud({}, 403).client.listProjects()).rejects.toThrow(
      "Evalution API: 403",
    );
    await expect(cloud({}, 404).client.listProjects()).rejects.toMatchObject({
      name: "EvalutionApiError",
      status: 404,
    });
  });

  it("rejects with the cloud's explanation", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ error: "Project not found." }), {
        status: 404,
      });
    await expect(
      new Evalution({ apiKey: PERSONAL, fetch }).listProjects(),
    ).rejects.toMatchObject({ status: 404, detail: "Project not found." });
  });

  it("refuses a call its key or project can't make, without a request", async () => {
    const { fetch, calls } = stubFetch();

    await expect(new Evalution({ fetch }).listProjects()).rejects.toThrow(
      "EVALUTION_API_KEY",
    );
    await expect(
      new Evalution({ apiKey: INGEST, project: "p", fetch }).listTraces(),
    ).rejects.toThrow("personal");
    await expect(
      new Evalution({ apiKey: PERSONAL, fetch }).listTraces(),
    ).rejects.toThrow("project");
    expect(calls).toEqual([]);
  });

  it("lets either kind of key call whoami", async () => {
    const { fetch, calls } = stubFetch();

    await new Evalution({ apiKey: INGEST, fetch }).whoami();

    expect(calls).toHaveLength(1);
  });
});

describe("the package's main entry point", () => {
  it("has no static node: imports, so it still loads on Workers", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const [, specifier] of source.matchAll(
        /^(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm,
      )) {
        expect(specifier, file).not.toMatch(/^node:/);
        if (specifier.startsWith("./")) visit(specifier.slice(2));
      }
    };

    visit("index.ts");

    expect(seen).toContain("client.ts");
  });
});
