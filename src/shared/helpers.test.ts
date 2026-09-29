// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { canEdit, versionLabel } from "./helpers.ts";

describe("canEdit", () => {
  const primitive = { kind: "primitive", value: "hi" } as const;
  const raw = { kind: "raw", sourceText: "buildSystem()" } as const;

  it("offers an empty or well-shaped slot the SDK supports", () => {
    expect(canEdit(true, undefined)).toBe(true);
    expect(canEdit(true, primitive)).toBe(true);
  });

  it("keeps a capability-true slot holding a raw value read-only", () => {
    expect(canEdit(true, raw)).toBe(false);
  });

  it("keeps a slot the SDK doesn't support read-only, whatever it holds", () => {
    expect(canEdit(false, undefined)).toBe(false);
    expect(canEdit(false, primitive)).toBe(false);
  });

  it("treats a call with no known binding as not editable", () => {
    expect(
      canEdit(true, { kind: "functionCall", callee: "helper", args: [] }),
    ).toBe(false);
  });
});

describe("versionLabel", () => {
  it("names a commit by its short sha, and a snapshot by what it was of", () => {
    expect(
      versionLabel({
        id: "0123456789abcdef",
        kind: "commit",
        time: 0,
      }),
    ).toBe("0123456");
    expect(
      versionLabel({
        id: "fedcba987",
        kind: "snapshot",
        parent: "0123456789abcdef",
        time: 0,
      }),
    ).toBe("snapshot of 0123456");
    expect(
      versionLabel({
        id: "blob:abcdef123",
        kind: "snapshot",
        fileOnly: true,
        time: 0,
      }),
    ).toBe("file snapshot abcdef1");
  });
});
