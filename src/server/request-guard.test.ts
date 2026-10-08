// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestGuard, requestRefusal } from "./request-guard.ts";

describe("requestRefusal", () => {
  it.each([
    "localhost:3000",
    "LOCALHOST:3000",
    "127.0.0.1:3000",
    "[::1]:3000",
    "evalution.myapp.localhost",
    "192.168.1.5:3000",
    "[fe80::1]:3000",
  ])("accepts a request addressed to %s", host => {
    expect(requestRefusal(host, undefined)).toBeUndefined();
  });

  it.each([
    "evil.example",
    "evil.example:3000",
    // Looks like loopback, but is a name DNS rebinding could point anywhere.
    "localhost.evil.example",
    "127.0.0.1.evil.example",
  ])("refuses a request addressed to %s (DNS rebinding)", host => {
    expect(requestRefusal(host, undefined)).toMatch(/Host/);
  });

  it("accepts a request addressed to an allowed name, case-insensitively", () => {
    expect(
      requestRefusal("Evalution.MyApp.test", undefined, [
        "evalution.myapp.test",
      ]),
    ).toBeUndefined();
  });

  it("accepts a request with no Host or Origin", () => {
    expect(requestRefusal(undefined, undefined)).toBeUndefined();
  });

  it.each([
    "http://localhost:3000",
    // The Vite dev server, proxying to the API on another port.
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "https://evalution.myapp.localhost",
  ])("accepts a page on %s", origin => {
    expect(requestRefusal("localhost:3000", origin)).toBeUndefined();
  });

  it("accepts a page the request's own host served", () => {
    expect(
      requestRefusal("192.168.1.5:3000", "http://192.168.1.5:3000"),
    ).toBeUndefined();
  });

  it("accepts a page the request's own host served, however it's written", () => {
    expect(
      requestRefusal("[FE80:0::1]:80", "http://[fe80::1]"),
    ).toBeUndefined();
  });

  it("accepts a page on an allowed name", () => {
    expect(
      requestRefusal("localhost:4123", "https://evalution.myapp.test", [
        "evalution.myapp.test",
      ]),
    ).toBeUndefined();
  });

  it.each([
    ["localhost:3000", "https://evil.example"],
    // A page served from a bare IP is still another site.
    ["localhost:3000", "http://1.2.3.4"],
    ["192.168.1.5:3000", "http://192.168.1.6:3000"],
    // Same host, different port: another server's page.
    ["192.168.1.5:3000", "http://192.168.1.5:8080"],
    // Sandboxed frames and `file:` pages.
    ["localhost:3000", "null"],
  ])("refuses a request to %s from a page on %s", (host, origin) => {
    expect(requestRefusal(host, origin)).toMatch(/aren't allowed/);
  });
});

describe("requestGuard", () => {
  /** An app answering "ok" behind the guard. */
  const guarded = () => {
    const app = new Hono();
    app.use(requestGuard());
    app.all("*", c => c.text("ok"));
    return app;
  };

  it("lets an allowed request through to the routes", async () => {
    const res = await guarded().request("http://localhost:3000/api/prompts", {
      headers: { origin: "http://localhost:3000" },
    });
    expect(await res.text()).toBe("ok");
  });

  it("answers 403 to a cross-site simple request before any route runs", async () => {
    // A `fetch` with a `text/plain` body needs no CORS preflight.
    const res = await guarded().request(
      "http://localhost:3000/api/prompts/p/x/execute",
      {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "text/plain",
        },
        body: "{}",
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Requests from 'https://evil.example' aren't allowed",
    });
  });

  it("answers 403 to a request addressed to another host", async () => {
    const res = await guarded().request("/api/prompts", {
      headers: { host: "evil.example" },
    });
    expect(res.status).toBe(403);
  });
});
