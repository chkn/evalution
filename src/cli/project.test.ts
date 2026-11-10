// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Span } from "@evalution/sdk";
import { BaseTraceIngestor } from "@evalution/sdk";
import { describe, expect, it } from "vitest";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
import { movedExportError, setUpProject } from "./project.ts";

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
    const { otlpIngestor, traceEventIngestor } = await setUpProject(
      "/project",
      {
        useDotenv: false,
        promptProviders: [
          {
            setupTraceIngestion: async () => ingestor,
          } as unknown as PromptProvider,
        ],
        traceProviders: [traces],
        datasetProviders: [],
        evalProviders: [],
      },
    );

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
    await traceEventIngestor.ingest([
      {
        type: "span-start",
        span: {
          ...span("sent"),
          resource: { "deployment.environment.name": "staging" },
        },
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
    ).toEqual({ ours: "playground", app: "production", sent: "staging" });
  });
});

describe("movedExportError", () => {
  it("says where an export that left `evalution` went", () => {
    const err = new SyntaxError(
      "The requested module 'evalution' does not provide an export named 'VercelAISDK'",
    );
    expect(movedExportError(err)?.message).toContain(
      "import it from '@evalution/vercel-ai-sdk/config'",
    );
  });

  it.each([
    ["VercelAISDKTelemetry", "@evalution/vercel-ai-sdk"],
    ["TypeSafeSDK", "@evalution/typesafe-sdk/config"],
    ["TypeSafeTelemetry", "@evalution/typesafe-sdk"],
    ["GeminiInteractionsSDK", "@evalution/gemini-interactions-sdk/config"],
  ])("sends %s to %s", (name, target) => {
    const err = new SyntaxError(
      `The requested module 'evalution' does not provide an export named '${name}'`,
    );
    expect(movedExportError(err)?.message).toContain(`'${target}'`);
  });

  it("leaves another module's missing export alone", () => {
    const err = new SyntaxError(
      "The requested module './mine.ts' does not provide an export named 'VercelAISDK'",
    );
    expect(movedExportError(err)).toBeUndefined();
  });

  it("leaves any other missing export alone", () => {
    const err = new SyntaxError(
      "The requested module 'evalution' does not provide an export named 'Nope'",
    );
    expect(movedExportError(err)).toBeUndefined();
    expect(movedExportError(new Error("boom"))).toBeUndefined();
  });
});
