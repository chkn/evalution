// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  filterTraces,
  groupTraceSummaries,
  mergeTraceGroups,
  parseTraceGroupQuery,
  parseTraceQuery,
  type TraceFilter,
  traceDateBucket,
  traceQueryParams,
} from "./trace-query.ts";
import type { TraceSummary } from "./trace-types.ts";

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

const ids = (traces: TraceSummary[]) => traces.map(t => t.id);

describe("filterTraces", () => {
  it("returns the traces themselves for an empty query", () => {
    const traces = [trace("a")];
    expect(filterTraces(traces, undefined)).toBe(traces);
    expect(filterTraces(traces, { search: "  ", filters: [] })).toBe(traces);
  });

  it("searches names and ids, whatever the case", () => {
    const traces = [
      trace("abc1", { name: "Summarize ticket" }),
      trace("def2", { name: "answer" }),
    ];
    expect(ids(filterTraces(traces, { search: "SUMMAR" }))).toEqual(["abc1"]);
    expect(ids(filterTraces(traces, { search: " EF2 " }))).toEqual(["def2"]);
    expect(filterTraces(traces, { search: "nothing" })).toEqual([]);
  });

  it("matches text columns by value, null standing for none", () => {
    const traces = [
      trace("a", { model: "gpt" }),
      trace("b", { model: "claude" }),
      trace("c"),
    ];
    const only = (filter: TraceFilter) =>
      ids(filterTraces(traces, { filters: [filter] }));
    expect(only({ column: "model", op: "in", values: ["gpt", null] })).toEqual([
      "a",
      "c",
    ]);
    expect(only({ column: "model", op: "notIn", values: [null] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("matches number columns by half-open range, or by having no value", () => {
    const traces = [
      trace("fast", { startTime: 0, endTime: 500 }),
      trace("edge", { startTime: 0, endTime: 1000 }),
      trace("running", { endTime: undefined, status: "running" }),
    ];
    const only = (filter: TraceFilter) =>
      ids(filterTraces(traces, { filters: [filter] }));
    expect(only({ column: "duration", op: "range", max: 1000 })).toEqual([
      "fast",
    ]);
    expect(only({ column: "duration", op: "range", min: 1000 })).toEqual([
      "edge",
    ]);
    expect(only({ column: "duration", op: "unset" })).toEqual(["running"]);
  });

  it("reads annotations and checks as their most pressing kind", () => {
    const traces = [
      trace("flagged", { annotationCounts: { issue: 1, good: 4, note: 0 } }),
      trace("liked", { annotationCounts: { issue: 0, good: 1, note: 2 } }),
      trace("failing", {
        checkCounts: { pass: 3, fail: 1, error: 0, skipped: 0, scored: 0 },
      }),
    ];
    const only = (filter: TraceFilter) =>
      ids(filterTraces(traces, { filters: [filter] }));
    expect(only({ column: "annotations", op: "in", values: ["good"] })).toEqual(
      ["liked"],
    );
    expect(only({ column: "checks", op: "in", values: ["fail"] })).toEqual([
      "failing",
    ]);
    expect(only({ column: "checks", op: "in", values: [null] })).toEqual([
      "flagged",
      "liked",
    ]);
  });

  it("requires every filter, and the search", () => {
    const traces = [
      trace("a", { model: "gpt", status: "error" }),
      trace("b", { model: "gpt" }),
    ];
    expect(
      ids(
        filterTraces(traces, {
          search: "a",
          filters: [
            { column: "model", op: "in", values: ["gpt"] },
            { column: "status", op: "in", values: ["error"] },
          ],
        }),
      ),
    ).toEqual(["a"]);
  });
});

describe("traceDateBucket", () => {
  const at = (iso: string) => Date.parse(iso);

  it("finds the UTC day by default", () => {
    expect(traceDateBucket(at("2026-11-12T15:30:00Z"))).toEqual({
      min: at("2026-11-12T00:00:00Z"),
      max: at("2026-11-13T00:00:00Z"),
    });
  });

  it("starts days, weeks and months on the time zone's clock", () => {
    const ms = at("2026-11-12T02:30:00Z"); // The evening of the 11th in New York.
    const zone = "America/New_York";
    expect(traceDateBucket(ms, "day", zone)).toEqual({
      min: at("2026-11-11T05:00:00Z"),
      max: at("2026-11-12T05:00:00Z"),
    });
    // Monday the 9th.
    expect(traceDateBucket(ms, "week", zone)).toEqual({
      min: at("2026-11-09T05:00:00Z"),
      max: at("2026-11-16T05:00:00Z"),
    });
    // November starts on daylight time, an hour nearer UTC, and ends off it.
    expect(traceDateBucket(ms, "month", zone)).toEqual({
      min: at("2026-11-01T04:00:00Z"),
      max: at("2026-12-01T05:00:00Z"),
    });
  });

  it("makes a day with a clock change as long as it was", () => {
    // Clocks went back on 1 November 2026 in New York: a 25-hour day.
    const { min, max } = traceDateBucket(
      at("2026-11-01T12:00:00Z"),
      "day",
      "America/New_York",
    );
    expect(max - min).toBe(25 * 3_600_000);
  });

  it("counts hours in elapsed time, in zones off the hour too", () => {
    expect(
      traceDateBucket(at("2026-11-12T15:40:00Z"), "hour", "Asia/Kolkata"),
    ).toEqual({
      min: at("2026-11-12T15:30:00Z"),
      max: at("2026-11-12T16:30:00Z"),
    });
  });
});

describe("groupTraceSummaries", () => {
  it("groups by a text column's value, with a group for none", () => {
    const groups = groupTraceSummaries(
      [
        trace("a", { model: "gpt", cost: 1 }),
        trace("b"),
        trace("c", { model: "gpt", cost: 2, status: "error" }),
      ],
      { column: "model" },
    );
    expect(groups).toEqual([
      {
        key: 'model:in:["gpt"]',
        filter: { column: "model", op: "in", values: ["gpt"] },
        count: 2,
        summary: expect.objectContaining({
          model: "gpt",
          cost: 3,
          status: "error",
          spanCount: 2,
        }),
      },
      {
        key: "model:in:[null]",
        filter: { column: "model", op: "in", values: [null] },
        count: 1,
        summary: expect.not.objectContaining({ model: expect.anything() }),
      },
    ]);
  });

  it("groups numbers into buckets, with a group for no value", () => {
    const groups = groupTraceSummaries(
      [
        trace("cheap", { cost: 0.0005 }),
        trace("bound", { cost: 0.01 }),
        trace("mid", { cost: 0.05 }),
        trace("dear", { cost: 25 }),
        trace("free"),
      ],
      { column: "cost" },
    );
    expect(groups.map(g => [g.filter, g.count])).toEqual([
      [{ column: "cost", op: "range", max: 0.001 }, 1],
      [{ column: "cost", op: "range", min: 0.01, max: 0.1 }, 2],
      [{ column: "cost", op: "range", min: 10 }, 1],
      [{ column: "cost", op: "unset" }, 1],
    ]);
  });

  it("groups start times at the resolution, in the time zone", () => {
    const groups = groupTraceSummaries(
      [
        trace("late", { startTime: Date.parse("2026-11-12T02:30:00Z") }),
        trace("next", { startTime: Date.parse("2026-11-12T12:00:00Z") }),
      ],
      { column: "startTime", resolution: "day" },
      "America/New_York",
    );
    expect(groups.map(g => g.filter)).toEqual([
      {
        column: "startTime",
        op: "range",
        min: Date.parse("2026-11-11T05:00:00Z"),
        max: Date.parse("2026-11-12T05:00:00Z"),
      },
      {
        column: "startTime",
        op: "range",
        min: Date.parse("2026-11-12T05:00:00Z"),
        max: Date.parse("2026-11-13T05:00:00Z"),
      },
    ]);
  });

  it("lists exactly a group's traces when its filter joins the query", () => {
    const traces = [
      trace("a", { startTime: 0, endTime: 100 }),
      trace("b", { startTime: 0, endTime: 7000 }),
      trace("c", { endTime: undefined, status: "running" }),
      trace("d", { startTime: 0, endTime: 900 }),
    ];
    const groups = groupTraceSummaries(traces, { column: "duration" });
    expect(
      groups.map(g => ids(filterTraces(traces, { filters: [g.filter] }))),
    ).toEqual([["a", "d"], ["b"], ["c"]]);
  });
});

describe("mergeTraceGroups", () => {
  it("adds up groups with the same key and keeps the rest", () => {
    const local = groupTraceSummaries(
      [trace("a", { model: "gpt", totalTokens: 5 }), trace("b")],
      { column: "model" },
    );
    const cloud = groupTraceSummaries(
      [
        trace("c", { model: "gpt", totalTokens: 7, startTime: 10 }),
        trace("d", { model: "claude" }),
      ],
      { column: "model" },
    );
    const merged = mergeTraceGroups([...local, ...cloud]);
    expect(merged.map(g => [g.key, g.count])).toEqual([
      ['model:in:["gpt"]', 2],
      ["model:in:[null]", 1],
      ['model:in:["claude"]', 1],
    ]);
    expect(merged[0]!.summary).toMatchObject({
      model: "gpt",
      totalTokens: 12,
      startTime: 10,
      spanCount: 2,
    });
  });
});

describe("traceQueryParams", () => {
  it("round-trips a group query", () => {
    const query = {
      search: "ticket",
      filters: [
        { column: "model", op: "in", values: ["a,b", null] },
        { column: "cost", op: "range", min: 0.01 },
        { column: "duration", op: "unset" },
      ] satisfies TraceFilter[],
      groupBy: { column: "startTime" as const, resolution: "week" as const },
      timeZone: "Europe/Berlin",
    };
    expect(parseTraceGroupQuery(traceQueryParams(query))).toEqual(query);
  });

  it("writes nothing for an empty query", () => {
    expect(traceQueryParams({ search: " ", filters: [] })).toEqual({});
    expect(parseTraceQuery({})).toEqual({});
  });

  it("refuses what it can't read, saying why", () => {
    expect(() => parseTraceQuery({ filters: "{" })).toThrow(TypeError);
    expect(() =>
      parseTraceQuery({
        filters: JSON.stringify([{ column: "cost", op: "in", values: ["x"] }]),
      }),
    ).toThrow(/Not a trace filter/);
    expect(() => parseTraceGroupQuery({ groupBy: "nope" })).toThrow(/groupBy/);
    expect(() =>
      parseTraceGroupQuery({ groupBy: "startTime", resolution: "year" }),
    ).toThrow(/resolution/);
    expect(() =>
      parseTraceGroupQuery({ groupBy: "model", tz: "Mars/Olympus" }),
    ).toThrow(/tz/);
  });
});
