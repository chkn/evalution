// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { TraceEvalRun, TraceSummary } from "../../shared/types";
import { groupTraces } from "./trace-groups";

const run = (runId: string): TraceEvalRun => ({
  providerId: "ev",
  evalId: "e1",
  evalName: "Answers",
  runId,
  startedAt: 100,
});

const trace = (
  id: string,
  overrides: Partial<TraceSummary> = {},
): TraceSummary => ({
  id,
  providerId: "mem",
  name: id,
  startTime: 1000,
  endTime: 2000,
  status: "ok",
  spanCount: 1,
  annotationCounts: { issue: 0, good: 0, note: 0 },
  ...overrides,
});

describe("groupTraces", () => {
  it("leaves traces from no eval run or playground stretch as they are", () => {
    const traces = [trace("a"), trace("b", { environment: "production" })];
    expect(groupTraces(traces)).toEqual(traces);
  });

  it("gathers a run's traces under one group, where its first trace was", () => {
    const a = trace("a", { evalRun: run("r1") });
    const b = trace("b");
    const c = trace("c", { evalRun: run("r2") });
    const d = trace("d", { evalRun: run("r1") });

    const items = groupTraces([a, b, c, d]);
    expect(items.map(i => i.id)).toEqual(["eval-run:r1", "b", "eval-run:r2"]);
    expect(items[0]).toMatchObject({
      providerId: "ev",
      name: "Answers",
      evalRun: run("r1"),
      children: [a, d],
    });
    expect(items[2]!.children).toEqual([c]);
  });

  it("summarizes its traces: their span, summed counts, and shared values", () => {
    const [group] = groupTraces([
      trace("a", {
        evalRun: run("r1"),
        startTime: 1000,
        endTime: 1500,
        spanCount: 2,
        totalTokens: 10,
        cost: 0.5,
        model: "m",
        promptVersion: "v1",
        promptVariation: "x",
        annotationCounts: { issue: 1, good: 0, note: 2 },
      }),
      trace("b", {
        evalRun: run("r1"),
        startTime: 1200,
        endTime: 3000,
        spanCount: 3,
        model: "m",
        promptVersion: "v2",
        status: "error",
        annotationCounts: { issue: 0, good: 4, note: 0 },
      }),
    ]);
    expect(group).toMatchObject({
      startTime: 1000,
      endTime: 3000,
      status: "error",
      spanCount: 5,
      totalTokens: 10,
      cost: 0.5,
      model: "m",
      annotationCounts: { issue: 1, good: 4, note: 2 },
    });
    // The traces ran different versions, and only one a variation.
    expect(group).not.toHaveProperty("promptVersion");
    expect(group).not.toHaveProperty("promptVariation");
  });

  it("is running, with no end, while any of its traces is", () => {
    const [group] = groupTraces([
      trace("a", { evalRun: run("r1"), status: "error" }),
      trace("b", { evalRun: run("r1"), status: "running", endTime: undefined }),
    ]);
    expect(group!.status).toBe("running");
    expect(group).not.toHaveProperty("endTime");
  });

  describe("playground runs", () => {
    const pg = (id: string, startTime: number, overrides = {}) =>
      trace(id, { environment: "playground", startTime, ...overrides });

    it("gathers a stretch of two or more under one group, but leaves a lone one", () => {
      const items = groupTraces([
        pg("p4", 40),
        pg("p3", 30),
        trace("app"),
        pg("p2", 20),
        trace("app2"),
        pg("p1", 10),
      ]);
      expect(items.map(i => i.id)).toEqual([
        "playground:p3",
        "app",
        "p2",
        "app2",
        "p1",
      ]);
      expect(items[0]).toMatchObject({
        providerId: "mem",
        name: "Playground",
        startTime: 30,
      });
      expect(items[0]!.children!.map(c => c.id)).toEqual(["p4", "p3"]);
      expect(items[0]).not.toHaveProperty("evalRun");
    });

    it("keeps the group's id as newer runs join it", () => {
      const before = groupTraces([pg("p2", 20), pg("p1", 10)]);
      const after = groupTraces([pg("p3", 30), pg("p2", 20), pg("p1", 10)]);
      expect(after[0]!.id).toBe(before[0]!.id);
    });

    it("is broken up by an eval run, whose own traces stay in its group", () => {
      const items = groupTraces([
        pg("p3", 30),
        pg("e1", 25, { evalRun: run("r1") }),
        pg("p2", 20),
        pg("p1", 10),
      ]);
      expect(items.map(i => i.id)).toEqual([
        "p3",
        "eval-run:r1",
        "playground:p1",
      ]);
    });
  });
});
