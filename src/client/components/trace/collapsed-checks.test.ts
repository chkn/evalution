// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLAPSED_CHECKS_KEY,
  type CollapsedEntry,
  openCollapsedRuns,
  saveCollapsedRuns,
  touchEntry,
} from "./collapsed-checks.ts";

describe("touchEntry", () => {
  it("moves a trace to the front, keeping its runs", () => {
    const entries: CollapsedEntry[] = [
      ["a", ["r1"]],
      ["b", ["r2"]],
    ];
    expect(touchEntry(entries, "b")).toEqual([
      ["b", ["r2"]],
      ["a", ["r1"]],
    ]);
  });

  it("replaces a trace's runs when given", () => {
    expect(touchEntry([["a", ["r1"]]], "a", [])).toEqual([["a", []]]);
  });

  it("evicts the trace opened longest ago past the limit", () => {
    const entries: CollapsedEntry[] = [
      ["a", []],
      ["b", []],
      ["c", []],
    ];
    expect(touchEntry(entries, "d", ["r"], 3)).toEqual([
      ["d", ["r"]],
      ["a", []],
      ["b", []],
    ]);
  });

  it("doesn't evict anything when reopening a remembered trace", () => {
    const entries: CollapsedEntry[] = [
      ["a", []],
      ["b", []],
    ];
    expect(touchEntry(entries, "b", undefined, 2).map(([k]) => k)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("remembered collapsed runs", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  it("recalls what was saved for a trace", () => {
    saveCollapsedRuns("t1", new Set(["r1"]));
    saveCollapsedRuns("t2", new Set(["r2"]));
    expect(openCollapsedRuns("t1")).toEqual(new Set(["r1"]));
  });

  it("counts opening a trace as using it", () => {
    saveCollapsedRuns("old", new Set(["r"]));
    for (let i = 0; i < 49; i++) saveCollapsedRuns(`t${i}`, new Set());
    openCollapsedRuns("old");
    saveCollapsedRuns("new", new Set());
    expect(openCollapsedRuns("old")).toEqual(new Set(["r"]));
    expect(openCollapsedRuns("t0")).toEqual(new Set());
    expect(
      JSON.parse(localStorage.getItem(COLLAPSED_CHECKS_KEY) ?? "[]"),
    ).toHaveLength(50);
  });

  it("forgets the trace opened longest ago", () => {
    saveCollapsedRuns("first", new Set(["r"]));
    for (let i = 0; i < 50; i++) saveCollapsedRuns(`t${i}`, new Set());
    expect(openCollapsedRuns("first")).toEqual(new Set());
  });

  it("ignores stored junk", () => {
    localStorage.setItem(COLLAPSED_CHECKS_KEY, "{not json");
    expect(openCollapsedRuns("t")).toEqual(new Set());
  });
});
