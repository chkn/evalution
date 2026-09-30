// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type {
  EvalCheckOutcome,
  EvalCheckResult,
  EvalResults,
  EvalRowResult,
} from "../../eval/eval-types";
import {
  compareRuns,
  formatRate,
  gridRows,
  percentile,
  summarizeArm,
} from "./eval-summary";

const row = (
  armId: string,
  rowId: string,
  rowIndex: number,
  extra: Partial<EvalRowResult> = {},
): EvalRowResult => ({
  runId: "r",
  armId,
  rowId,
  sample: 0,
  rowIndex,
  rowCells: {},
  status: "ok",
  ...extra,
});

const check = (
  armId: string,
  rowId: string,
  checkId: string,
  outcome: EvalCheckOutcome,
  score?: number,
): EvalCheckResult => ({
  runId: "r",
  armId,
  rowId,
  sample: 0,
  checkId,
  outcome,
  ...(score !== undefined && { score }),
});

const results: EvalResults = {
  rows: [
    row("a0", "x", 1, { costUsd: 0.1, durationMs: 100 }),
    row("a0", "w", 0, { costUsd: 0.2, durationMs: 300 }),
    row("a0", "z", 2, { status: "error" }),
  ],
  checks: [
    check("a0", "w", "c1", "pass"),
    check("a0", "x", "c1", "fail"),
    check("a0", "z", "c1", "skipped"),
    check("a0", "w", "c2", "scored", 0.5),
    check("a0", "x", "c2", "scored", 1),
  ],
};

describe("summarizeArm", () => {
  it("summarizes each check, cost and durations", () => {
    expect(summarizeArm(results, "a0", ["c1", "c2"])).toEqual({
      armId: "a0",
      checks: [
        {
          checkId: "c1",
          counts: { pass: 1, fail: 1, error: 0, skipped: 1, scored: 0 },
          passRate: 0.5,
        },
        {
          checkId: "c2",
          counts: { pass: 0, fail: 0, error: 0, skipped: 0, scored: 2 },
          meanScore: 0.75,
        },
      ],
      rowErrors: 1,
      totalCost: expect.closeTo(0.3),
      p50Duration: 100,
      p95Duration: 300,
    });
  });
});

describe("gridRows", () => {
  it("orders rows as the run saw them", () => {
    expect(gridRows(results).map(r => r.rowId)).toEqual(["w", "x", "z"]);
  });
});

describe("compareRuns", () => {
  it("lists changed cells for same-labelled arms, regressions first", () => {
    const before = {
      arms: [{ id: "a0", label: "Working tree" }],
      results: {
        rows: [],
        checks: [
          check("a0", "w", "c1", "fail"),
          check("a0", "x", "c1", "pass"),
          check("a0", "z", "c1", "skipped"),
        ],
      },
    };
    const after = {
      arms: [{ id: "a1", label: "Working tree" }],
      results: {
        rows: [],
        checks: [
          check("a1", "w", "c1", "pass"),
          check("a1", "x", "c1", "fail"),
          check("a1", "z", "c1", "skipped"),
          check("a1", "new", "c1", "pass"),
        ],
      },
    };
    expect(compareRuns(after, before)).toEqual([
      expect.objectContaining({ rowId: "x", before: "pass", regressed: true }),
      expect.objectContaining({ rowId: "w", after: "pass", regressed: false }),
    ]);
  });
});

describe("helpers", () => {
  it("computes nearest-rank percentiles and formats rates", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBeUndefined();
    expect(formatRate(0.834)).toBe("83%");
    expect(formatRate(undefined)).toBe("—");
  });
});
