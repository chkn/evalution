// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { instrument, PROMPT_IDENTITY, prompts } from "./index.js";

// A type alias, not an interface: the SDK's state is JSON, and only an
// alias's properties are checked against JSON's index signature.
type Ticket = {
  subject: string;
};

const triagePrompts = prompts({ id: "support-triage" }, () => ({
  triage: (ticket: Ticket, product: string) => ({
    state: { ticket },
    questions: {
      refund_requested: noul(`Refund for ${product}?`),
      team: choice("Which team?", { billing: "Payments", technical: null }),
    },
  }),
}));

const ANSWERS = {
  refund_requested: { type: "noul", noul: 0.9 },
  team: {
    type: "choice",
    choice: "billing",
    confidence: 0.8,
    probabilities: { billing: 0.8, technical: 0.2 },
  },
};

function clientWith(
  status = 200,
  body: unknown = {
    model: "jev-latest",
    answers: ANSWERS,
    usage: { input_tokens: 12, output_tokens: 3 },
  },
) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch,
    retry: { maxRetries: 0 },
  });
  return { client, fetch };
}

function tracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, tracer: provider.getTracer("test") };
}

describe("prompts()", () => {
  it("returns the request as built, with its identity under a symbol", () => {
    const request = triagePrompts().triage({ subject: "Charged twice" }, "Pro");
    expect(request.state).toEqual({ ticket: { subject: "Charged twice" } });
    expect((request as any)[PROMPT_IDENTITY]).toEqual({
      name: "triage",
      id: "support-triage#triage",
      functionParameters: [{ subject: "Charged twice" }, "Pro"],
    });
  });

  it("keeps the identity through a spread, and out of the serialized body", async () => {
    const request = {
      ...triagePrompts().triage({ subject: "x" }, "Pro"),
      model: "jev-2",
    };
    expect((request as any)[PROMPT_IDENTITY]?.id).toBe("support-triage#triage");
    expect(JSON.parse(JSON.stringify(request))).not.toHaveProperty(
      String(PROMPT_IDENTITY),
    );

    const { client, fetch } = clientWith();
    await instrument(client, tracing()).systemOne(request);
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
  });

  it("preserves answer types inferred from the questions", async () => {
    const { client } = clientWith();
    const { answers } = await client.systemOne(
      triagePrompts().triage({ subject: "x" }, "Pro"),
    );
    expectTypeOf(answers.team.choice).toEqualTypeOf<"billing" | "technical">();
    expectTypeOf(answers.refund_requested.noul).toEqualTypeOf<number>();
    // @ts-expect-error — not one of the prompt's questions
    answers.not_a_question;
  });
});

describe("instrument()", () => {
  it("records a prompt's call as a span linked to the prompt", async () => {
    const { client } = clientWith();
    const { exporter, tracer } = tracing();
    await instrument(client, { tracer }).systemOne(
      triagePrompts().triage({ subject: "x" }, "Pro"),
    );
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(1));

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes).toMatchObject({
      "evalution.prompt.id": "support-triage#triage",
      "gen_ai.provider.name": "typesafe",
      "gen_ai.response.model": "jev-latest",
      "gen_ai.output.type": "json",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 3,
    });
    expect(JSON.parse(String(span.attributes["evalution.llm.input"]))).toEqual({
      state: { ticket: { subject: "x" } },
      questions: {
        refund_requested: { type: "noul", instructions: "Refund for Pro?" },
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "Payments", technical: null },
        },
      },
    });
    expect(JSON.parse(String(span.attributes["evalution.llm.output"]))).toEqual(
      ANSWERS,
    );
  });

  it("records a failed call as an error span", async () => {
    const { client } = clientWith(422, {
      detail: [{ loc: ["body", "state"], msg: "Field required" }],
    });
    const { exporter, tracer } = tracing();
    await expect(
      instrument(client, { tracer }).systemOne(
        triagePrompts().triage({ subject: "x" }, "Pro"),
      ),
    ).rejects.toThrow(/422/);
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(1));
    expect(exporter.getFinishedSpans()[0].status).toMatchObject({
      code: 2,
      message: "422 state: Field required",
    });
  });

  it("records a call once when a client is instrumented twice", async () => {
    const { client } = clientWith();
    const { exporter, tracer } = tracing();
    instrument(client, { tracer });
    const systemOne = client.systemOne;
    expect(instrument(client, { tracer })).toBe(client);
    expect(client.systemOne).toBe(systemOne);

    await client.systemOne(triagePrompts().triage({ subject: "x" }, "Pro"));
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(1));
  });

  it("passes other calls straight through", async () => {
    const { client } = clientWith();
    const { exporter, tracer } = tracing();
    await instrument(client, { tracer }).systemOne({
      state: "hi",
      questions: { spam: noul("Spam?") },
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
