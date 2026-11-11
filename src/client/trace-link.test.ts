// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { linkedTrace, traceLink } from "./trace-link.ts";

describe("traceLink", () => {
  it("links to the trace from the project URL", () => {
    expect(
      traceLink("https://app--octo.local.evalut.io", {
        providerId: "local-db",
        traceId: "t 1&x",
      }),
    ).toBe(
      "https://app--octo.local.evalut.io/?trace=t+1%26x&provider=local-db",
    );
  });

  it("reads back what it wrote", () => {
    const trace = { providerId: "local-db", traceId: "t 1&x" };
    expect(
      linkedTrace(new URL(traceLink("https://p.example", trace)).search),
    ).toEqual(trace);
  });
});

describe("linkedTrace", () => {
  it("needs both the trace and its provider", () => {
    expect(linkedTrace("?trace=t1")).toBeUndefined();
    expect(linkedTrace("?provider=p")).toBeUndefined();
    expect(linkedTrace("")).toBeUndefined();
  });
});
