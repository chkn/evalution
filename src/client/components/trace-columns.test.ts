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
  traceVariationLabel,
  traceVersionLabel,
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
      { key: "version", visible: false },
      { key: "variation", visible: false },
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
      { key: "variation", visible: true },
      { key: "version", visible: false },
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
      { key: "version", visible: false },
      { key: "variation", visible: false },
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
      { key: "version", visible: false },
      { key: "variation", visible: false },
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
      "version",
      "variation",
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
      "version",
      "variation",
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
    // Name (120) + startTime (100) + spanCount (40) + duration (55) +
    // totalTokens (56) = 371, + 24px chrome = 395 — between 340 and 480.
    expect(
      tableModeWidth(
        withVisible("startTime", "spanCount", "duration", "totalTokens"),
      ),
    ).toBe(395);
  });

  it("adding a visible column widens the total by exactly that column's own width, when unclamped", () => {
    // 55 + 56 + 64 + 40 = 215, + 120 name + 24 chrome = 359 (unclamped).
    const base = withVisible("duration", "totalTokens", "cost", "spanCount");
    // + model (110) = 325 -> 469 (still unclamped, i.e. < 480).
    const withModel = withVisible(
      "duration",
      "totalTokens",
      "cost",
      "spanCount",
      "model",
    );
    expect(tableModeWidth(base)).toBe(359);
    expect(tableModeWidth(withModel)).toBe(469);
  });

  it("ignores the order columns are in — only visibility and identity matter", () => {
    const forward = withVisible("startTime", "model", "cost");
    const backward = [...forward].reverse();
    expect(tableModeWidth(forward)).toBe(tableModeWidth(backward));
  });
});

describe("traceVersionLabel / traceVariationLabel", () => {
  it("label a trace's version by what it was, once looked up", () => {
    const trace = { promptVersion: "fedcba9876543210" };
    expect(traceVersionLabel(trace, {})).toBe("fedcba9");
    expect(
      traceVersionLabel(trace, {
        fedcba9876543210: {
          id: "fedcba9876543210",
          kind: "snapshot",
          parent: "0123456789",
          time: 0,
        },
      }),
    ).toBe("snapshot of 0123456");
    expect(traceVersionLabel({}, {})).toBe("—");
  });

  it("label a trace's variation by its name when it has one", () => {
    const trace = { promptVariation: "var_abcdefghij" };
    expect(traceVariationLabel(trace, {})).toBe("abcdefg");
    expect(
      traceVariationLabel(trace, {
        var_abcdefghij: {
          id: "var_abcdefghij",
          promptId: "p#p",
          base: "v",
          updates: { style: "chat" },
          wip: false,
          names: ["terse"],
          createdAt: 0,
          updatedAt: 0,
        },
      }),
    ).toBe("terse");
    expect(traceVariationLabel({}, {})).toBe("—");
  });
});
