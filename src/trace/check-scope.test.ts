// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { CheckScope, CheckScopeTraceSink } from "./check-scope.ts";
import { MemoryTraceProvider } from "./memory-trace-provider.ts";
import { CHECK_ATTRIBUTE, type Span } from "./trace-types.ts";

/** A judged trace, already over, and a sink feeding its provider. */
async function setUp() {
  const traces = new MemoryTraceProvider();
  const sink = new CheckScopeTraceSink();
  sink.addSink(traces);
  const root: Span = {
    id: "run:root",
    traceId: "run",
    name: "answer",
    kind: "AGENT",
    startTime: 1,
  };
  await sink.recordSpanStart(root);
  await sink.recordSpanEnd({ ...root, endTime: 5, status: "ok" });
  const scope = new CheckScope({
    traceId: "run",
    parentId: "run:root",
    name: "LLM judge",
    checkId: "c1",
  });
  return { traces, sink, scope };
}

/** A call's own trace: a root and one child, as an ingestor records it. */
async function judgeCall(sink: CheckScopeTraceSink, id: string) {
  const root: Span = {
    id: `${id}:root`,
    traceId: id,
    name: "evaluate",
    kind: "LLM",
    startTime: 10,
  };
  const child: Span = {
    id: `${id}:step`,
    traceId: id,
    parentId: root.id,
    name: "step",
    kind: "LLM",
    startTime: 11,
  };
  await sink.recordSpanStart(root);
  await sink.recordSpanStart(child);
  await sink.recordSpanEnd({ ...child, endTime: 12, status: "ok" });
  await sink.recordSpanEnd({ ...root, endTime: 13, status: "ok" });
}

describe("CheckScopeTraceSink", () => {
  it("re-homes a check's trace under a CHECK span in the judged trace", async () => {
    const { traces, sink, scope } = await setUp();
    await scope.run(() => judgeCall(sink, "judge"));
    await scope.end({ outcome: "fail", message: "judged no" });

    expect(await traces.hasTrace("judge")).toBe(false);
    const judged = await traces.getTrace("run");
    expect(judged?.trace.status).toBe("ok");
    const check = judged?.spans.find(s => s.kind === "CHECK");
    expect(check).toMatchObject({
      parentId: "run:root",
      name: "LLM judge",
      status: "ok",
      attributes: {
        [CHECK_ATTRIBUTE]: "c1",
        "evalution.check.outcome": "fail",
        "evalution.check.message": "judged no",
      },
    });
    expect(check?.endTime).toBeDefined();
    const byId = new Map(judged?.spans.map(s => [s.id, s]));
    expect(byId.get("judge:root")).toMatchObject({
      traceId: "run",
      parentId: check?.id,
      endTime: 13,
      attributes: { [CHECK_ATTRIBUTE]: "c1" },
    });
    expect(byId.get("judge:step")).toMatchObject({
      traceId: "run",
      parentId: "judge:root",
      attributes: { [CHECK_ATTRIBUTE]: "c1" },
    });
  });

  it("puts a check's concurrent calls under one CHECK span", async () => {
    const { traces, sink, scope } = await setUp();
    await scope.run(() =>
      Promise.all([judgeCall(sink, "a"), judgeCall(sink, "b")]),
    );
    await scope.end({ outcome: "pass" });

    const { spans } = (await traces.getTrace("run"))!;
    const checks = spans.filter(s => s.kind === "CHECK");
    expect(checks).toHaveLength(1);
    expect(
      spans.filter(s => s.parentId === checks[0]!.id).map(s => s.id),
    ).toEqual(["a:root", "b:root"]);
  });

  it("adds nothing for a check that traces nothing", async () => {
    const { traces, scope } = await setUp();
    await scope.run(async () => {});
    await scope.end({ outcome: "pass" });
    expect((await traces.getTrace("run"))?.spans).toHaveLength(1);
  });

  it("marks the CHECK span an error when the check errored", async () => {
    const { traces, sink, scope } = await setUp();
    await scope.run(() => judgeCall(sink, "judge"));
    await scope.end({ outcome: "error", message: "Timed out" });
    const check = (await traces.getTrace("run"))?.spans.find(
      s => s.kind === "CHECK",
    );
    expect(check).toMatchObject({ status: "error", errorMessage: "Timed out" });
  });

  it("doesn't fail the judged trace when a check's call fails", async () => {
    const { traces, sink, scope } = await setUp();
    await scope.run(() => sink.failTrace("judge", "bad model"));
    expect((await traces.getTrace("run"))?.trace.status).toBe("ok");
  });

  it("passes spans recorded outside a scope through untouched", async () => {
    const { traces, sink } = await setUp();
    await judgeCall(sink, "other");
    expect((await traces.getTrace("other"))?.spans).toHaveLength(2);
    await sink.failTrace("other", "boom");
    expect((await traces.getTrace("other"))?.trace.status).toBe("error");
  });
});
