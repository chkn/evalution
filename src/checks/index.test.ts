// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { CheckRun } from "../prompt/playground/check.ts";
import type { Span, TraceWithSpans } from "../trace/trace-types.ts";
import {
  builtinCheck,
  builtinCheckInfos,
  finalText,
  maxCost,
  maxDuration,
  outputContains,
  outputEquals,
  toolCalled,
  toolCalls,
  traceDuration,
} from "./index.ts";

function span(partial: Partial<Span> & Pick<Span, "id" | "kind">): Span {
  return {
    traceId: "t",
    name: partial.id,
    startTime: 0,
    endTime: 10,
    ...partial,
  };
}

function runOf(spans: Span[], extra: Partial<CheckRun> = {}): CheckRun {
  const trace: TraceWithSpans = {
    trace: { id: "t", name: "t", startTime: 0, endTime: 100, status: "ok" },
    spans,
  };
  return {
    trace,
    row: { id: "r", cells: {}, createdAt: 0 },
    status: "ok",
    ...extra,
  };
}

const spans: Span[] = [
  span({ id: "root", kind: "AGENT", startTime: 0, endTime: 100 }),
  span({
    id: "llm1",
    kind: "LLM",
    parentId: "root",
    startTime: 1,
    llm: { output: "first", cost: { prompt: 0.01, completion: 0.02 } },
  }),
  span({
    id: "tool",
    kind: "TOOL",
    parentId: "root",
    startTime: 2,
    tool: { toolName: "create_task", input: { title: "x" } },
  }),
  span({
    id: "llm2",
    kind: "LLM",
    parentId: "root",
    startTime: 3,
    llm: { output: "Created Set up CI", cost: { prompt: 0.01, completion: 0 } },
  }),
];

describe("trace helpers", () => {
  it("reads the final text, tool calls, and duration", () => {
    const { trace } = runOf(spans);
    expect(finalText(trace)).toBe("Created Set up CI");
    expect(toolCalls(trace)).toEqual([
      { name: "create_task", input: { title: "x" } },
    ]);
    expect(traceDuration(trace)).toBe(100);
  });
});

/** Runs a built-in with already-validated inputs. */
const judge = (c: { run: (i: any, r: CheckRun) => unknown }, inputs: object) =>
  c.run(inputs, runOf(spans));

describe("built-in checks", () => {
  it("outputContains, case-insensitive by default", () => {
    expect(judge(outputContains, { text: "set up ci" })).toEqual({
      pass: true,
    });
    expect(
      judge(outputContains, { text: "set up ci", caseSensitive: true }),
    ).toMatchObject({ pass: false });
  });

  it("outputEquals, as text or as JSON", () => {
    expect(judge(outputEquals, { expected: "Created Set up CI" })).toEqual({
      pass: true,
    });
    const json = runOf([
      span({ id: "l", kind: "LLM", llm: { output: { a: 1, b: [2] } } }),
    ]);
    expect(outputEquals.run({ expected: '{"b":[2],"a":1}' }, json)).toEqual({
      pass: true,
    });
  });

  it("toolCalled, optionally an exact number of times", () => {
    expect(judge(toolCalled, { name: "create_task" })).toEqual({ pass: true });
    expect(judge(toolCalled, { name: "create_task", times: 2 })).toMatchObject(
      { pass: false, message: expect.stringMatching(/1 time, not 2/) },
    );
    expect(judge(toolCalled, { name: "success" })).toMatchObject({
      pass: false,
    });
  });

  it("maxCost and maxDuration", () => {
    expect(judge(maxCost, { usd: 0.05 })).toMatchObject({ pass: true });
    expect(judge(maxCost, { usd: 0.01 })).toMatchObject({ pass: false });
    expect(judge(maxDuration, { ms: 50 })).toMatchObject({ pass: false });
  });

  it("refuses to guess from an incomplete trace", () => {
    expect(() =>
      outputContains.run({ text: "x", caseSensitive: undefined }, runOf(spans, { traceIncomplete: true })),
    ).toThrow(/didn't finish arriving/);
  });

  it("are listed and looked up by URI", () => {
    const infos = builtinCheckInfos();
    expect(infos.map(i => i.uri)).toContain("evalution/checks#toolCalled");
    expect(builtinCheck("evalution/checks#toolCalled")).toBe(toolCalled);
    expect(builtinCheck("checks.ts#toolCalled")).toBeUndefined();
  });
});
