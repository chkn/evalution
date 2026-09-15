// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACE_COLUMNS,
  parseTraceColumns,
  reorderTraceColumns,
  type TraceColumnState,
  tableModeWidth,
  toggleTraceColumn,
} from "./trace-columns";

const ALL_KEYS = DEFAULT_TRACE_COLUMNS.map(c => c.key);

describe("DEFAULT_TRACE_COLUMNS", () => {
  it("starts date/spans/duration visible and the rest hidden", () => {
    expect(DEFAULT_TRACE_COLUMNS).toEqual([
      { key: "startTime", visible: true },
      { key: "spanCount", visible: true },
      { key: "duration", visible: true },
      { key: "totalTokens", visible: false },
      { key: "model", visible: false },
      { key: "cost", visible: false },
      { key: "annotations", visible: false },
    ]);
  });
});

describe("parseTraceColumns", () => {
  it("preserves a valid stored order and visibility as-is", () => {
    const stored: TraceColumnState[] = [
      { key: "duration", visible: false },
      { key: "cost", visible: true },
      { key: "startTime", visible: true },
      { key: "spanCount", visible: true },
      { key: "totalTokens", visible: true },
      { key: "model", visible: false },
      { key: "annotations", visible: true },
    ];
    expect(parseTraceColumns(stored)).toEqual(stored);
  });

  it("drops unknown keys", () => {
    const result = parseTraceColumns([
      { key: "bogus", visible: true },
      { key: "startTime", visible: true },
    ]);
    expect(result.map(c => c.key)).not.toContain("bogus");
  });

  it("keeps only the first occurrence of a repeated key", () => {
    const result = parseTraceColumns([
      { key: "startTime", visible: false },
      { key: "startTime", visible: true },
      ...ALL_KEYS.filter(k => k !== "startTime").map(key => ({
        key,
        visible: true,
      })),
    ]);
    expect(result.filter(c => c.key === "startTime")).toEqual([
      { key: "startTime", visible: false },
    ]);
  });

  it("appends a known key missing from storage, at its own default visibility, after the stored ones", () => {
    const result = parseTraceColumns([{ key: "duration", visible: false }]);
    expect(result).toEqual([
      { key: "duration", visible: false },
      { key: "startTime", visible: true },
      { key: "spanCount", visible: true },
      { key: "totalTokens", visible: false },
      { key: "model", visible: false },
      { key: "cost", visible: false },
      { key: "annotations", visible: false },
    ]);
  });

  it.each([
    null,
    undefined,
    "not an array",
    42,
    {},
  ])("falls back to the default layout for malformed input: %p", raw => {
    expect(parseTraceColumns(raw)).toEqual(DEFAULT_TRACE_COLUMNS);
  });

  it("drops entries with the wrong shape", () => {
    const result = parseTraceColumns([
      { key: "startTime" }, // missing `visible`
      { visible: true }, // missing `key`
      "startTime", // not an object
      { key: "spanCount", visible: true },
    ]);
    expect(result[0]).toEqual({ key: "spanCount", visible: true });
    // `spanCount` (the only surviving entry) comes first, then every other
    // known key is appended in `ALL_KEYS` order.
    expect(result.map(c => c.key)).toEqual([
      "spanCount",
      ...ALL_KEYS.filter(k => k !== "spanCount"),
    ]);
  });
});

describe("toggleTraceColumn", () => {
  it("flips only the targeted column, leaving order untouched", () => {
    const result = toggleTraceColumn(DEFAULT_TRACE_COLUMNS, "spanCount");
    expect(result).toEqual([
      { key: "startTime", visible: true },
      { key: "spanCount", visible: false },
      { key: "duration", visible: true },
      { key: "totalTokens", visible: false },
      { key: "model", visible: false },
      { key: "cost", visible: false },
      { key: "annotations", visible: false },
    ]);
  });
});

describe("reorderTraceColumns", () => {
  it("moves a column later, shifting the ones in between up", () => {
    const result = reorderTraceColumns(DEFAULT_TRACE_COLUMNS, 0, 2);
    expect(result.map(c => c.key)).toEqual([
      "spanCount",
      "duration",
      "startTime",
      "totalTokens",
      "model",
      "cost",
      "annotations",
    ]);
  });

  it("moves a column earlier, shifting the ones in between down", () => {
    const result = reorderTraceColumns(DEFAULT_TRACE_COLUMNS, 3, 0);
    expect(result.map(c => c.key)).toEqual([
      "totalTokens",
      "startTime",
      "spanCount",
      "duration",
      "model",
      "cost",
      "annotations",
    ]);
  });

  it("carries each column's own visible flag along with it", () => {
    const result = reorderTraceColumns(DEFAULT_TRACE_COLUMNS, 0, 2);
    expect(result[2]).toEqual({ key: "startTime", visible: true });
  });

  it("is a no-op moving a column to its own index", () => {
    expect(reorderTraceColumns(DEFAULT_TRACE_COLUMNS, 1, 1)).toEqual(
      DEFAULT_TRACE_COLUMNS,
    );
  });

  it.each([
    [-1, 1],
    [1, -1],
    [1, 99],
    [99, 1],
  ])("is a no-op for an out-of-range index (%i -> %i)", (from, to) => {
    expect(reorderTraceColumns(DEFAULT_TRACE_COLUMNS, from, to)).toEqual(
      DEFAULT_TRACE_COLUMNS,
    );
  });
});

describe("tableModeWidth", () => {
  const withVisible = (...keys: TraceColumnState["key"][]) =>
    DEFAULT_TRACE_COLUMNS.map(c => ({ ...c, visible: keys.includes(c.key) }));

  it("clamps up to the minimum when the visible columns are narrower than it", () => {
    expect(tableModeWidth(withVisible("spanCount"))).toBe(340);
    expect(tableModeWidth(withVisible())).toBe(340); // nothing visible at all
  });

  it("clamps down to the maximum when every column is visible", () => {
    expect(
      tableModeWidth(DEFAULT_TRACE_COLUMNS.map(c => ({ ...c, visible: true }))),
    ).toBe(480);
  });

  it("fits comfortably between the min and max for a middling set of columns", () => {
    // Name (120) + startTime (92) + spanCount (40) + duration (60) +
    // totalTokens (56) = 368, + 24px chrome = 392 — between 340 and 480.
    expect(
      tableModeWidth(
        withVisible("startTime", "spanCount", "duration", "totalTokens"),
      ),
    ).toBe(392);
  });

  it("adding a visible column widens the total by exactly that column's own width, when unclamped", () => {
    // 60 + 56 + 64 + 40 = 220, + 120 name + 24 chrome = 364 (unclamped).
    const base = withVisible("duration", "totalTokens", "cost", "spanCount");
    // + model (110) = 330 -> 474 (still unclamped, i.e. < 480).
    const withModel = withVisible(
      "duration",
      "totalTokens",
      "cost",
      "spanCount",
      "model",
    );
    expect(tableModeWidth(base)).toBe(364);
    expect(tableModeWidth(withModel)).toBe(474);
  });

  it("ignores the order columns are in — only visibility and identity matter", () => {
    const forward = withVisible("startTime", "model", "cost");
    const backward = [...forward].reverse();
    expect(tableModeWidth(forward)).toBe(tableModeWidth(backward));
  });
});
