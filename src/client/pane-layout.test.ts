// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { type PaneState, placeTab } from "./pane-layout";

const keyOf = (t: string) => t;
const pane = (id: string, ...tabs: string[]): PaneState<string> => ({
  id,
  tabs,
  activeTabKey: tabs.at(-1) ?? null,
});

describe("placeTab", () => {
  it("opens in the same pane when not splitting", () => {
    const r = placeTab(
      [pane("a", "x"), pane("b")],
      "a",
      "y",
      keyOf,
      {},
      () => "new",
    );
    expect(r.panes[0].tabs).toEqual(["x", "y"]);
    expect(r.panes[0].activeTabKey).toBe("y");
    expect(r.panes[1].tabs).toEqual([]);
    expect(r.focusId).toBe("a");
    expect(r.splitFrom).toBeUndefined();
  });

  it("splits a lone pane to the right when splitting", () => {
    const r = placeTab(
      [pane("a", "x")],
      "a",
      "y",
      keyOf,
      { split: true },
      () => "new",
    );
    expect(r.panes.map(p => p.id)).toEqual(["a", "new"]);
    expect(r.panes[1].tabs).toEqual(["y"]);
    expect(r.focusId).toBe("new");
    expect(r.splitFrom).toBe("a");
  });

  it("prefers the pane to the right when splitting", () => {
    const r = placeTab(
      [pane("a"), pane("b", "x"), pane("c")],
      "b",
      "y",
      keyOf,
      { split: true },
      () => "new",
    );
    expect(r.panes[2].tabs).toEqual(["y"]);
    expect(r.focusId).toBe("c");
  });

  it("falls back to the pane on the left when splitting from the last pane", () => {
    const r = placeTab(
      [pane("a"), pane("b", "x")],
      "b",
      "y",
      keyOf,
      { split: true },
      () => "new",
    );
    expect(r.panes[0].tabs).toEqual(["y"]);
    expect(r.focusId).toBe("a");
  });

  it("focuses a tab that's already open elsewhere either way", () => {
    for (const split of [false, true]) {
      const r = placeTab(
        [pane("a", "x"), pane("b", "y", "z")],
        "a",
        "y",
        keyOf,
        { split },
        () => "new",
      );
      expect(r.panes[1].activeTabKey).toBe("y");
      expect(r.panes[0].tabs).toEqual(["x"]);
      expect(r.focusId).toBe("b");
      expect(r.flashId).toBe("b");
    }
  });

  it("swaps an already-open tab when replacing", () => {
    const r = placeTab(
      [pane("a", "x:old")],
      "a",
      "x:new",
      t => t.split(":")[0],
      { replace: true },
      () => "new",
    );
    expect(r.panes[0].tabs).toEqual(["x:new"]);
  });
});
