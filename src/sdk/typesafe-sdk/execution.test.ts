// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { choice, noul } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryTraceProvider } from "../../trace/memory-trace-provider.ts";
import { TypeSafeSDK } from "./index.ts";
import { PROMPT_IDENTITY } from "./telemetry.ts";

const ANSWERS = {
  spam: { type: "noul", noul: 0.12 },
  team: {
    type: "choice",
    choice: "billing",
    confidence: 0.9,
    probabilities: { billing: 0.9, technical: 0.1 },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const request = () => ({
  state: { subject: "Charged twice" },
  questions: {
    spam: noul("Is this spam?"),
    team: choice("Which team?", { billing: null, technical: null }),
  },
});

let sinks: { sdk: TypeSafeSDK; provider: MemoryTraceProvider }[] = [];

async function setup(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const sdk = new TypeSafeSDK({
    client: { apiKey: "test-key", fetch, retry: { maxRetries: 0 } },
  });
  const provider = new MemoryTraceProvider();
  (await sdk.setupTraceIngestion()).addSink(provider);
  sinks.push({ sdk, provider });
  return { sdk, provider };
}

afterEach(async () => {
  for (const { sdk, provider } of sinks) {
    (await sdk.setupTraceIngestion()).removeSink(provider);
  }
  sinks = [];
  vi.restoreAllMocks();
});

describe("TypeSafeSDK.executeConfig", () => {
  it("records the call as a root LLM span with its input, answers and usage", async () => {
    const fetch = vi.fn(async () =>
      json({
        model: "jev-2",
        answers: ANSWERS,
        usage: { input_tokens: 40, output_tokens: 6 },
      }),
    );
    const { sdk, provider } = await setup(fetch);
    const config = {
      ...request(),
      [PROMPT_IDENTITY]: { id: "support-triage#triage", name: "triage" },
    };

    const handle = await sdk.executeConfig(config, {
      traceId: "t1",
      rootSpanId: "t1:root",
    });
    await handle.done;

    // The identity symbol never reaches the API.
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);

    const trace = await provider.getTrace("t1");
    expect(trace?.trace.status).toBe("ok");
    expect(trace?.spans).toHaveLength(1);
    const [span] = trace!.spans;
    expect(span).toMatchObject({
      id: "t1:root",
      kind: "LLM",
      status: "ok",
      name: "support-triage#triage",
      prompt: { id: "support-triage#triage" },
    });
    expect(span.llm).toEqual({
      provider: "typesafe",
      model: "jev-2",
      input: { state: config.state, questions: config.questions },
      output: ANSWERS,
      promptTokens: 40,
      completionTokens: 6,
      totalTokens: 46,
    });
  });

  it("records the SDK's own message for a validation error", async () => {
    const fetch = vi.fn(async () =>
      json(
        {
          detail: [
            {
              loc: ["body", "questions", "team", "criteria"],
              msg: "Field required",
            },
          ],
        },
        422,
      ),
    );
    const { sdk, provider } = await setup(fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const handle = await sdk.executeConfig(request(), { traceId: "t2" });
    await handle.done;

    const trace = await provider.getTrace("t2");
    expect(trace?.trace.status).toBe("error");
    expect(trace?.spans[0]).toMatchObject({
      id: "t2:root",
      status: "error",
      errorMessage: "422 questions.team.criteria: Field required",
    });
  });

  it("records a config the SDK rejects before sending anything", async () => {
    const fetch = vi.fn();
    const { sdk, provider } = await setup(fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const handle = await sdk.executeConfig(
      { state: "hi", questions: {} },
      { traceId: "t3" },
    );
    await handle.done;

    expect(fetch).not.toHaveBeenCalled();
    const [span] = (await provider.getTrace("t3"))!.spans;
    expect(span.status).toBe("error");
    expect(span.errorMessage).toMatch(/At least one question is required/);
  });
});
