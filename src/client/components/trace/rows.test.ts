// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  allProvenanceSpans,
  nativeSpan,
  otlpSpan,
  makeSpan as span,
  toolSpan,
} from "./__fixtures__/spans.ts";
import {
  barGeometry,
  buildGroupedRows,
  buildRows,
  computeWindow,
  newMessagesByTurn,
  spanDuration,
} from "./rows.ts";

describe("buildRows", () => {
  it("nests children under their parent, earliest first", () => {
    const rows = buildRows([
      span("b", { parentId: "root", startTime: 20 }),
      span("a", { parentId: "root", startTime: 10 }),
      span("root"),
      span("a1", { parentId: "a", startTime: 11 }),
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
      span("orphan", { parentId: "never-arrived", startTime: 5 }),
      span("child", { parentId: "orphan", startTime: 6 }),
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

describe("buildGroupedRows", () => {
  it("groups spans by name, ordered by each group's earliest start", () => {
    const groups = buildGroupedRows([
      span("call1", { name: "fetch", kind: "TOOL", startTime: 10 }),
      span("root", { name: "root", kind: "AGENT", startTime: 0 }),
      span("call2", { name: "fetch", kind: "TOOL", startTime: 20 }),
    ]);

    expect(groups.map(g => g.name)).toEqual(["root", "fetch"]);
    const fetchGroup = groups.find(g => g.name === "fetch")!;
    expect(fetchGroup.kind).toBe("TOOL");
    expect(fetchGroup.spans.map(s => s.id)).toEqual(["call1", "call2"]);
  });

  it("orders each group's spans by start time, not input order", () => {
    const [group] = buildGroupedRows([
      span("late", { name: "fetch", startTime: 20 }),
      span("early", { name: "fetch", startTime: 10 }),
    ]);

    expect(group.spans.map(s => s.id)).toEqual(["early", "late"]);
  });
});

describe("barGeometry", () => {
  const window = { start: 100, end: 300 };

  it("positions a finished span as percentages of the window", () => {
    expect(
      barGeometry(span("a", { startTime: 150, endTime: 250 }), window),
    ).toEqual({ left: "25%", width: "50%" });
  });

  it("extends a still-running span to the window's end", () => {
    expect(barGeometry(span("a", { startTime: 200 }), window)).toEqual({
      left: "50%",
      width: "50%",
    });
  });

  it("keeps an instantaneous span at least 0.5% wide", () => {
    expect(
      barGeometry(span("a", { startTime: 100, endTime: 100 }), window),
    ).toEqual({ left: "0%", width: "0.5%" });
  });
});

describe("newMessagesByTurn", () => {
  it("only returns the messages appended since the previous LLM turn", () => {
    const rows = buildRows([
      span("turn1", {
        kind: "LLM",
        startTime: 0,
        llm: {
          input: [
            { role: "system", content: "be helpful" },
            { role: "user", content: "hi" },
          ],
        },
      }),
      span("turn2", {
        kind: "LLM",
        startTime: 1,
        llm: {
          input: [
            { role: "system", content: "be helpful" },
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello!" },
            { role: "user", content: "how are you?" },
          ],
        },
      }),
    ]);

    const result = newMessagesByTurn(rows);
    expect(result.get("turn1")).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(result.get("turn2")).toEqual([
      { role: "assistant", content: "hello!" },
      { role: "user", content: "how are you?" },
    ]);
  });

  it("counts a turn's output as an already-shown message once the next turn's messages fold it back in", () => {
    const rows = buildRows([
      span("turn1", {
        kind: "LLM",
        startTime: 0,
        llm: {
          input: [{ role: "user", content: "first question" }],
          output: "first answer",
        },
      }),
      span("turn2", {
        kind: "LLM",
        startTime: 1,
        llm: {
          input: [
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "second question" },
          ],
          output: "second answer",
        },
      }),
    ]);

    const result = newMessagesByTurn(rows);
    expect(result.get("turn1")).toEqual([
      { role: "user", content: "first question" },
    ]);
    // "first answer" is already shown via turn1's `output`, not repeated here.
    expect(result.get("turn2")).toEqual([
      { role: "user", content: "second question" },
    ]);
  });

  it("ignores TOOL spans and treats a span with no messages as empty", () => {
    const rows = buildRows([
      span("llm", { kind: "LLM", startTime: 0 }),
      span("tool", { kind: "TOOL", startTime: 1 }),
    ]);

    const result = newMessagesByTurn(rows);
    expect(result.get("llm")).toEqual([]);
    expect(result.has("tool")).toBe(false);
  });
});

describe("computeWindow", () => {
  it("widens to cover spans outside the trace's own bounds", () => {
    expect(
      computeWindow(100, 200, [
        span("a", { startTime: 50, endTime: 150 }),
        span("b", { startTime: 120, endTime: 300 }),
      ]),
    ).toEqual({ start: 50, end: 300 });
  });

  it("never returns an empty window", () => {
    expect(computeWindow(100, undefined, [])).toEqual({ start: 100, end: 101 });
  });
});

describe("spanDuration", () => {
  it("is the elapsed time of a finished span", () => {
    expect(spanDuration(span("a", { startTime: 100, endTime: 250 }))).toBe(150);
  });

  it("is undefined while a span is still running", () => {
    expect(spanDuration(span("a", { startTime: 100 }))).toBeUndefined();
  });
});

/**
 * The pure layer has to cope with all three ingestion provenances, which
 * disagree on shape — see `specs/trace-workshopping.md` §D. These guard the
 * two divergences that have actually bitten: a native-telemetry span with no
 * `attributes` bag at all, and an OTLP span whose message content is
 * multi-part rather than a plain string.
 */
describe("three-provenance parity", () => {
  it("lays out spans of every provenance, orphaned parents included", () => {
    const rows = buildRows(allProvenanceSpans);

    // `nativeSpan`/`toolSpan` name a parent ("t1:root") that isn't in the
    // list, so they render as roots rather than vanishing.
    expect(rows).toHaveLength(allProvenanceSpans.length);
    expect(rows.every(r => r.depth === 0)).toBe(true);
    expect(new Set(rows.map(r => r.span.id))).toEqual(
      new Set(allProvenanceSpans.map(s => s.id)),
    );
  });

  it("covers every provenance's extent in the timeline window", () => {
    expect(computeWindow(1000, 1500, allProvenanceSpans)).toEqual({
      start: 1000,
      end: 2100, // otlpSpan ends last
    });
  });

  it("reads messages off a native-telemetry span that has no attributes", () => {
    expect(nativeSpan.attributes).toBeUndefined();
    const result = newMessagesByTurn(buildRows([nativeSpan]));
    expect(result.get("s-native")).toEqual([{ role: "user", content: "hi" }]);
  });

  it("passes an OTLP span's multi-part message content through untouched", () => {
    const result = newMessagesByTurn(buildRows([otlpSpan]));
    expect(result.get("s-otlp")).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", image: "https://x/y.png", mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("yields no chat turn for a TOOL span", () => {
    const result = newMessagesByTurn(buildRows([toolSpan]));
    expect(result.has("s-tool")).toBe(false);
  });
});
