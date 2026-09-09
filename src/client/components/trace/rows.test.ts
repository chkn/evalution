// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { buildRows, computeWindow } from "./rows.ts";
import type { SpanViewModel } from "./spanViewModel.ts";

function span(
  id: string,
  overrides: Partial<SpanViewModel> = {},
): SpanViewModel {
  return {
    id,
    name: id,
    spanType: "DEFAULT",
    startMs: 0,
    ...overrides,
  };
}

describe("buildRows", () => {
  it("nests children under their parent, earliest first", () => {
    const rows = buildRows([
      span("b", { parentId: "root", startMs: 20 }),
      span("a", { parentId: "root", startMs: 10 }),
      span("root"),
      span("a1", { parentId: "a", startMs: 11 }),
    ]);

    expect(rows.map(r => [r.span.id, r.depth])).toEqual([
      ["root", 0],
      ["a", 1],
      ["a1", 2],
      ["b", 1],
    ]);
  });

  it("renders a span whose parent is absent as a root of its own", () => {
    // An OTLP batch can arrive without its root span; those children must
    // still show up rather than silently vanishing from the waterfall.
    const rows = buildRows([
      span("orphan", { parentId: "never-arrived", startMs: 5 }),
      span("child", { parentId: "orphan", startMs: 6 }),
    ]);

    expect(rows.map(r => [r.span.id, r.depth])).toEqual([
      ["orphan", 0],
      ["child", 1],
    ]);
  });

  it("terminates on a parent cycle instead of recursing forever", () => {
    const rows = buildRows([
      span("x", { parentId: "y" }),
      span("y", { parentId: "x" }),
    ]);

    expect(rows).toHaveLength(0);
  });
});

describe("computeWindow", () => {
  it("widens to cover spans outside the trace's own bounds", () => {
    expect(
      computeWindow(100, 200, [
        span("a", { startMs: 50, endMs: 150 }),
        span("b", { startMs: 120, endMs: 300 }),
      ]),
    ).toEqual({ start: 50, end: 300 });
  });

  it("never returns an empty window", () => {
    expect(computeWindow(100, undefined, [])).toEqual({ start: 100, end: 101 });
  });
});
