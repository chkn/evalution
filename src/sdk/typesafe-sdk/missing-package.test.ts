// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import { TypeSafeSDK } from "./index.ts";

// Simulate a project that hasn't installed the SDK: importing it fails the way
// Node reports a missing package (vitest wraps the error, keeping it as the
// cause).
vi.mock("@typesafe-ai/sdk", () => {
  const err = new Error(
    "Cannot find package '@typesafe-ai/sdk' imported from /project/x.js",
  ) as NodeJS.ErrnoException;
  err.code = "ERR_MODULE_NOT_FOUND";
  throw err;
});

describe("TypeSafeSDK without the SDK installed", () => {
  it("explains how to install it when executing", async () => {
    await expect(
      new TypeSafeSDK().executeConfig({ state: "hi", questions: {} }),
    ).rejects.toThrow(/npm install @typesafe-ai\/sdk/);
  });

  it("still offers the default model", async () => {
    const def = await new TypeSafeSDK().getModelDefinition({});
    expect(def.catalogs?.[0].groups[0].presets).toEqual([
      {
        label: "jev-latest",
        value: { kind: "primitive", value: "jev-latest" },
      },
    ]);
  });
});
