// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TraceGroup, TraceQuery, TraceSummary } from "@evalution/sdk";
import { describe, expect, it } from "vitest";
import type { EvalProvider } from "../../eval/eval-provider.ts";
import type { EvalRunner } from "../../eval/eval-runner.ts";
import { type EvalTraceRun, emptyCounts } from "../../eval/eval-types.ts";
import { MemoryTraceProvider } from "../../trace/memory-trace-provider.ts";
import type { TraceProvider } from "../../trace/trace-provider.ts";
import {
  handleListTraceGroups,
  handleListTraces,
  handleTraceEvalRun,
} from "./traces.ts";

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

/** A provider of fixed traces that ignores every query it's asked. */
function fixedProvider(id: string, traces: Partial<TraceSummary>[]) {
  const asked: (TraceQuery | undefined)[] = [];
  const provider: TraceProvider = {
    id,
    getAllTraces: async query => {
      asked.push(query);
      return traces.map(
        (trace, i): TraceSummary => ({
          id: `${id}-${i}`,
          providerId: id,
          name: `${id}-${i}`,
          startTime: 10 - i,
          endTime: 20,
          status: "ok",
          spanCount: 1,
          annotationCounts: { issue: 0, good: 0, note: 0 },
          ...trace,
        }),
      );
    },
    getTrace: async () => undefined,
  };
  return { provider, asked };
}

/** An eval provider recording `checkCounts` against each of `traceIds`. */
const evalsWithChecks = (traceProviderId: string, traceIds: string[]) => ({
  providers: [
    {
      id: "ev",
      listTraceRuns: async () =>
        traceIds.map(traceId => ({
          ...LINK,
          traceProviderId,
          traceId,
          checkCounts: { ...emptyCounts(), fail: 1 },
        })),
    } as unknown as EvalProvider,
  ],
});

describe("handleListTraces with a query", () => {
  it("asks the providers, and filters what one that ignores it returns", async () => {
    const { provider, asked } = fixedProvider("a", [
      { model: "gpt" },
      { model: "claude" },
    ]);
    const query: TraceQuery = {
      filters: [{ column: "model", op: "in", values: ["gpt"] }],
    };

    const { body } = await handleListTraces([provider], undefined, query);

    expect(asked).toEqual([query]);
    expect((body as TraceSummary[]).map(t => t.id)).toEqual(["a-0"]);
  });

  it("filters by checks itself, never asking a provider to", async () => {
    const { provider, asked } = fixedProvider("a", [{}, {}]);

    const { body } = await handleListTraces(
      [provider],
      evalsWithChecks("a", ["a-1"]),
      { filters: [{ column: "checks", op: "in", values: ["fail"] }] },
    );

    expect(asked).toEqual([undefined]);
    expect((body as TraceSummary[]).map(t => t.id)).toEqual(["a-1"]);
  });
});

describe("handleListTraceGroups", () => {
  const groupsOf = async (...args: Parameters<typeof handleListTraceGroups>) =>
    (await handleListTraceGroups(...args)).body as TraceGroup[];

  it("adds up each provider's groups, grouping for one that can't", async () => {
    const plain = fixedProvider("a", [{ model: "gpt" }, { model: "claude" }]);
    const counting: TraceProvider = {
      ...fixedProvider("b", []).provider,
      groupTraces: async () => [
        {
          key: 'model:in:["gpt"]',
          filter: { column: "model", op: "in", values: ["gpt"] },
          count: 1000,
          summary: {
            startTime: 1,
            endTime: 2,
            status: "ok",
            spanCount: 5000,
            model: "gpt",
            annotationCounts: { issue: 0, good: 0, note: 0 },
          },
        },
      ],
    };

    const groups = await groupsOf([plain.provider, counting], undefined, {
      search: "a-",
      groupBy: { column: "model" },
    });

    expect(groups.map(g => [g.key, g.count])).toEqual([
      ['model:in:["gpt"]', 1001],
      ['model:in:["claude"]', 1],
    ]);
    expect(groups[0]!.summary).toMatchObject({ spanCount: 5001, model: "gpt" });
  });

  it("groups by checks itself, over the listed traces", async () => {
    const { provider } = fixedProvider("a", [{}, {}, {}]);
    const counting: TraceProvider = {
      ...provider,
      groupTraces: async () => {
        throw new Error("a provider doesn't know a trace's checks");
      },
    };

    const groups = await groupsOf(
      [counting],
      evalsWithChecks("a", ["a-0", "a-2"]),
      { groupBy: { column: "checks" } },
    );

    expect(groups.map(g => [g.filter, g.count])).toEqual([
      [{ column: "checks", op: "in", values: ["fail"] }, 2],
      [{ column: "checks", op: "in", values: [null] }, 1],
    ]);
    expect(groups[0]!.summary.checkCounts).toMatchObject({ fail: 2 });
  });
});

describe("handleTraceEvalRun", () => {
  const evals = (recorded: EvalTraceRun[], inFlight: EvalTraceRun[] = []) => ({
    providers: [
      {
        id: "ev",
        listTraceRuns: async () => recorded,
      } as unknown as EvalProvider,
    ],
    runner: {
      traceRuns: () => inFlight.map(l => ({ ...l, providerId: "ev" })),
    } as unknown as EvalRunner,
  });

  it("finds the run that produced a trace, recorded or in flight", async () => {
    for (const sources of [evals([LINK]), evals([], [LINK])]) {
      expect(await handleTraceEvalRun(sources, "mem", "t1")).toEqual({
        status: 200,
        body: { ...RUN, providerId: "ev" },
      });
    }
  });

  it("answers null for a trace no eval run produced", async () => {
    const sources = evals([LINK]);
    expect((await handleTraceEvalRun(sources, "mem", "t2")).body).toBeNull();
    expect((await handleTraceEvalRun(sources, "other", "t1")).body).toBeNull();
  });
});
