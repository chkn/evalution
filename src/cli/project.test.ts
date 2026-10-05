// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
import { BaseTraceIngestor } from "../trace/trace-ingestor.ts";
import type { Span } from "../trace/trace-types.ts";
import { setUpProject } from "./project.ts";

/** An in-process ingestor, as an SDK adapter's `setupTraceIngestion` returns one. */
class InProcessIngestor extends BaseTraceIngestor {
  async record(span: Span) {
    await this.recordSpanStart(span);
    await this.recordSpanEnd(span);
  }
}

const span = (traceId: string): Span => ({
  id: `${traceId}:root`,
  traceId,
  name: "run",
  kind: "DEFAULT",
  startTime: 1,
  endTime: 2,
  status: "ok",
});

describe("setUpProject", () => {
  it("marks the runs it records itself as playground runs, but not an app's", async () => {
    const ingestor = new InProcessIngestor();
    const traces = new MemoryTraceProvider();
    const { otlpIngestor } = await setUpProject("/project", {
      useDotenv: false,
      promptProviders: [
        {
          setupTraceIngestion: async () => ingestor,
        } as unknown as PromptProvider,
      ],
      traceProviders: [traces],
      datasetProviders: [],
      evalProviders: [],
    });

    await ingestor.record(span("ours"));
    await otlpIngestor.ingest([
      {
        traceId: "app",
        spanId: "app:root",
        name: "run",
        startTimeMs: 1,
        endTimeMs: 2,
        statusCode: "ok",
        attributes: {},
        resource: { "deployment.environment.name": "production" },
      },
    ]);

    expect((await traces.getTrace("ours"))?.spans[0]?.resource).toEqual({
      "service.name": "evalution",
      "deployment.environment.name": "playground",
    });
    expect(
      Object.fromEntries(
        (await traces.getAllTraces()).map(t => [t.id, t.environment]),
      ),
    ).toEqual({ ours: "playground", app: "production" });
  });
});
