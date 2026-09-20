// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { spanDisplayStatus, statusGlyph } from "./format.ts";

describe("statusGlyph", () => {
  it("maps each span status to a glyph", () => {
    expect(statusGlyph("ok")).toBe("✓");
    expect(statusGlyph("error")).toBe("✕");
    expect(statusGlyph("running")).toBe("●");
  });

  it("falls back for an unknown status", () => {
    expect(statusGlyph("weird")).toBe("?");
  });
});

describe("spanDisplayStatus", () => {
  it("uses the recorded status", () => {
    expect(spanDisplayStatus({ status: "error", endTime: 5 })).toBe("error");
  });

  it("reads a span with no end time and no status as running", () => {
    expect(spanDisplayStatus({})).toBe("running");
  });

  it("has nothing to show for an ended span with no status", () => {
    expect(spanDisplayStatus({ endTime: 5 })).toBeUndefined();
  });
});
