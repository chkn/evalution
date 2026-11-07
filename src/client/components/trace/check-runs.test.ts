// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { TraceEvalRun } from "../../../shared/types.ts";
import {
  countOutcomes,
  groupCheckRuns,
  type ProvidedCheckResult,
} from "./check-runs.ts";

const result = (
  checkId: string,
  overrides: Partial<ProvidedCheckResult> = {},
): ProvidedCheckResult => ({
  providerId: "e1",
  runId: "r1",
  armId: "a1",
  rowId: "row",
  sample: 0,
  checkId,
  outcome: "pass",
  evalId: "eval",
  evalName: "Answers",
  checkLabel: checkId,
  armLabel: "Working tree",
  startedAt: 1,
  ...overrides,
});

describe("groupCheckRuns", () => {
  it("puts one run's checks under a single group", () => {
    const groups = groupCheckRuns([result("c1"), result("c2")]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      providerId: "e1",
      runId: "r1",
      evalName: "Answers",
      armLabel: "Working tree",
      startedAt: 1,
    });
    expect(groups[0]!.results.map(r => r.checkId)).toEqual(["c1", "c2"]);
  });

  it("keeps runs and arms apart, in order of first appearance", () => {
    const groups = groupCheckRuns([
      result("c1", { runId: "r2" }),
      result("c2"),
      result("c3", { armId: "a2", armLabel: "Variation" }),
      result("c4", { runId: "r2" }),
    ]);

    expect(groups.map(g => [g.runId, g.armId])).toEqual([
      ["r2", "a1"],
      ["r1", "a1"],
      ["r1", "a2"],
    ]);
    expect(groups[0]!.results.map(r => r.checkId)).toEqual(["c1", "c4"]);
  });

  const evalRun: TraceEvalRun = {
    providerId: "e1",
    evalId: "eval",
    evalName: "Answers",
    runId: "r1",
    startedAt: 1,
    armId: "a1",
    armLabel: "Working tree",
  };

  it("has a group for the trace's own run even with no checks", () => {
    const groups = groupCheckRuns([], evalRun);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      runId: "r1",
      armLabel: "Working tree",
      results: [],
    });
  });

  it("puts the trace's own run first, sharing its group with its checks", () => {
    const groups = groupCheckRuns(
      [result("c1", { runId: "r2" }), result("c2")],
      evalRun,
    );

    expect(groups.map(g => g.runId)).toEqual(["r1", "r2"]);
    expect(groups[0]!.results.map(r => r.checkId)).toEqual(["c2"]);
  });

  it("is empty when no eval ran the trace", () => {
    expect(groupCheckRuns([])).toEqual([]);
  });
});

describe("countOutcomes", () => {
  it("counts results by outcome", () => {
    expect(
      countOutcomes([
        result("c1"),
        result("c2", { outcome: "fail" }),
        result("c3"),
        result("c4", { outcome: "scored", score: 0.5 }),
      ]),
    ).toEqual({ pass: 2, fail: 1, error: 0, skipped: 0, scored: 1 });
  });

  it("is all zeros with no results", () => {
    expect(countOutcomes([])).toEqual({
      pass: 0,
      fail: 0,
      error: 0,
      skipped: 0,
      scored: 0,
    });
  });
});
