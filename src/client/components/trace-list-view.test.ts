// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { TraceFilter } from "../../shared/types";
import {
  fromDateTimeInput,
  parseTraceGrouping,
  setColumnFilter,
  toDateTimeInput,
  traceFilterLabel,
  traceGroupLabel,
  typedRange,
  typedRangeFilter,
} from "./trace-list-view";

describe("parseTraceGrouping", () => {
  it("keeps a grouping it knows", () => {
    expect(parseTraceGrouping("none")).toBe("none");
    expect(parseTraceGrouping({ column: "model" })).toEqual({
      column: "model",
    });
    expect(
      parseTraceGrouping({ column: "startTime", resolution: "week" }),
    ).toEqual({ column: "startTime", resolution: "week" });
  });

  it("falls back to runs, and to days", () => {
    expect(parseTraceGrouping(undefined)).toBe("runs");
    expect(parseTraceGrouping({ column: "nope" })).toBe("runs");
    expect(
      parseTraceGrouping({ column: "startTime", resolution: "year" }),
    ).toEqual({ column: "startTime", resolution: "day" });
  });
});

describe("traceGroupLabel", () => {
  const label = (filter: TraceFilter) =>
    traceGroupLabel(filter, { column: filter.column });

  it("names a value, or the lack of one", () => {
    expect(label({ column: "model", op: "in", values: ["gpt-5"] })).toBe(
      "gpt-5",
    );
    expect(label({ column: "model", op: "in", values: [null] })).toBe(
      "No model",
    );
    expect(label({ column: "status", op: "in", values: ["error"] })).toBe(
      "Error",
    );
    expect(label({ column: "checks", op: "in", values: ["fail"] })).toBe(
      "Failing",
    );
    expect(
      label({ column: "version", op: "in", values: ["0123456789abcdef"] }),
    ).toBe("0123456");
  });

  it("names a variation by its name, once that's known", () => {
    const filter: TraceFilter = {
      column: "variation",
      op: "in",
      values: ["var_abcdefghij"],
    };
    expect(label(filter)).toBe("abcdefg");
    expect(
      traceGroupLabel(
        filter,
        { column: "variation" },
        { var_abcdefghij: { id: "var_abcdefghij", names: ["terse"] } as any },
      ),
    ).toContain("terse");
  });

  it("names a bucket by its bounds", () => {
    expect(label({ column: "duration", op: "range", max: 1000 })).toBe("< 1s");
    expect(
      label({ column: "duration", op: "range", min: 60_000, max: 300_000 }),
    ).toBe("1m – 5m");
    expect(label({ column: "duration", op: "unset" })).toBe("Running");
    expect(label({ column: "cost", op: "range", min: 0.01, max: 0.1 })).toBe(
      "$0.01 – $0.1",
    );
    expect(label({ column: "cost", op: "range", min: 10 })).toBe("≥ $10");
    expect(
      label({ column: "totalTokens", op: "range", min: 1000, max: 10_000 }),
    ).toBe("1K – 10K");
  });

  it("names span buckets by the counts in them", () => {
    expect(label({ column: "spanCount", op: "range", max: 2 })).toBe(
      "0–1 spans",
    );
    expect(label({ column: "spanCount", op: "range", min: 1, max: 2 })).toBe(
      "1 span",
    );
    expect(label({ column: "spanCount", op: "range", min: 2, max: 6 })).toBe(
      "2–5 spans",
    );
    expect(label({ column: "spanCount", op: "range", min: 101 })).toBe(
      "101+ spans",
    );
  });

  it("names a date bucket at its resolution", () => {
    const min = new Date(2026, 10, 9).getTime();
    const filter: TraceFilter = { column: "startTime", op: "range", min };
    const month = new Date(min).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
    expect(
      traceGroupLabel(filter, { column: "startTime", resolution: "month" }),
    ).toBe(month);
    expect(
      traceGroupLabel(filter, { column: "startTime", resolution: "week" }),
    ).toMatch(/^Week of /);
  });
});

describe("traceFilterLabel", () => {
  it("names the column and what it allows", () => {
    expect(
      traceFilterLabel({ column: "model", op: "in", values: ["gpt-5", null] }),
    ).toBe("Model: gpt-5, No model");
    expect(
      traceFilterLabel({ column: "duration", op: "range", min: 5000 }),
    ).toBe("Duration: ≥ 5s");
  });
});

describe("setColumnFilter", () => {
  const model: TraceFilter = { column: "model", op: "in", values: ["a"] };
  const cost: TraceFilter = { column: "cost", op: "range", min: 1 };

  it("adds, replaces in place, and removes a column's filter", () => {
    expect(setColumnFilter([model], "cost", cost)).toEqual([model, cost]);
    const replaced: TraceFilter = { column: "model", op: "in", values: ["b"] };
    expect(setColumnFilter([model, cost], "model", replaced)).toEqual([
      replaced,
      cost,
    ]);
    expect(setColumnFilter([model, cost], "model", undefined)).toEqual([cost]);
  });
});

describe("typedRangeFilter", () => {
  it("scales what's typed, and lets a whole number's max in", () => {
    const duration = typedRangeFilter("duration", 1.5, 5);
    expect(duration).toEqual({
      column: "duration",
      op: "range",
      min: 1500,
      max: 5000,
    });
    expect(typedRange("duration", duration)).toEqual({ min: 1.5, max: 5 });

    const spans = typedRangeFilter("spanCount", undefined, 5);
    expect(spans).toEqual({ column: "spanCount", op: "range", max: 6 });
    expect(typedRange("spanCount", spans)).toEqual({ max: 5 });
    expect(traceFilterLabel(spans!)).toBe("Spans: 0–5");

    expect(typedRangeFilter("cost", undefined, undefined)).toBeUndefined();
  });
});

describe("datetime-local values", () => {
  it("round-trips a minute on the local clock", () => {
    const ms = new Date(2026, 10, 12, 9, 5).getTime();
    expect(toDateTimeInput(ms)).toBe("2026-11-12T09:05");
    expect(fromDateTimeInput("2026-11-12T09:05")).toBe(ms);
    expect(toDateTimeInput(undefined)).toBe("");
    expect(fromDateTimeInput("")).toBeUndefined();
  });
});
