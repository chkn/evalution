// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { EvalProvider } from "../../eval/eval-provider.ts";
import type { EvalRunner } from "../../eval/eval-runner.ts";
import { type EvalTraceRun, emptyCounts } from "../../eval/eval-types.ts";
import { MemoryTraceProvider } from "../../trace/memory-trace-provider.ts";
import { handleListTraces } from "./traces.ts";

const LINK: EvalTraceRun = {
  traceProviderId: "mem",
  traceId: "t1",
  evalId: "e1",
  evalName: "Answers",
  runId: "r1",
  startedAt: 1,
  armId: "a1",
  armLabel: "Working tree",
};
const { traceProviderId: _p, traceId: _t, ...RUN } = LINK;

async function listed(
  recorded: EvalTraceRun[],
  inFlight: EvalTraceRun[] = [],
): Promise<any[]> {
  const traces = new MemoryTraceProvider({ id: "mem" });
  await traces.recordSpanStart({
    id: "t1:root",
    traceId: "t1",
    name: "root",
    kind: "LLM",
    startTime: 1,
  });
  const provider = {
    id: "ev",
    listTraceRuns: async () => recorded,
  } as unknown as EvalProvider;
  const runner = {
    traceRuns: () => inFlight.map(l => ({ ...l, providerId: "ev" })),
  } as unknown as EvalRunner;
  const { body } = await handleListTraces([traces], {
    providers: [provider],
    runner,
  });
  return body as any[];
}

describe("handleListTraces", () => {
  const checkCounts = { ...emptyCounts(), pass: 2 };

  it("adds a trace's eval run and check counts", async () => {
    const [trace] = await listed([{ ...LINK, checkCounts }]);
    expect(trace.evalRun).toEqual({ ...RUN, providerId: "ev" });
    expect(trace.checkCounts).toEqual(checkCounts);
  });

  it("keeps the recorded check counts of a trace whose run is in flight", async () => {
    const [trace] = await listed([{ ...LINK, checkCounts }], [LINK]);
    expect(trace.checkCounts).toEqual(checkCounts);
  });

  it("leaves check counts off a trace that has none yet", async () => {
    const [trace] = await listed([], [LINK]);
    expect(trace.evalRun).toBeDefined();
    expect(trace).not.toHaveProperty("checkCounts");
  });
});
