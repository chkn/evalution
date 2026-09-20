// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { parseMessages, readLLM, readTool } from "./otel-attributes.ts";

describe("parseMessages", () => {
  it("keeps an all-text content array collapsed to a plain string", () => {
    const messages = parseMessages(
      JSON.stringify([
        {
          role: "user",
          content: [
            { type: "text", text: "hi " },
            { type: "text", text: "there" },
          ],
        },
      ]),
    );
    expect(messages).toEqual([{ role: "user", content: "hi there" }]);
  });

  it("keeps an image content part rather than dropping the message", () => {
    const messages = parseMessages(
      JSON.stringify([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              image: "data:image/png;base64,abc",
              mediaType: "image/png",
            },
          ],
        },
      ]),
    );
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            image: "data:image/png;base64,abc",
            mediaType: "image/png",
          },
        ],
      },
    ]);
  });

  it("keeps an image-only message that previously would have been dropped", () => {
    const messages = parseMessages(
      JSON.stringify([
        {
          role: "user",
          content: [
            { type: "image", image: "https://x/y.png", mediaType: "image/png" },
          ],
        },
      ]),
    );
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", image: "https://x/y.png", mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("treats an image-bearing file part as an image", () => {
    const messages = parseMessages(
      JSON.stringify([
        {
          role: "user",
          content: [
            { type: "file", data: "https://x/y.jpg", mediaType: "image/jpeg" },
          ],
        },
      ]),
    );
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", image: "https://x/y.jpg", mediaType: "image/jpeg" },
        ],
      },
    ]);
  });

  it("drops a non-image file part along with any other unsupported parts", () => {
    const messages = parseMessages(
      JSON.stringify([
        {
          role: "user",
          content: [
            { type: "file", data: "abc", mediaType: "application/pdf" },
          ],
        },
      ]),
    );
    expect(messages).toEqual([]);
  });
});

describe("readTool", () => {
  it("returns undefined when no tool name attribute is present", () => {
    expect(readTool({})).toBeUndefined();
  });

  it("reads the Vercel AI SDK's ai.toolCall.* attributes, JSON-parsing args/result", () => {
    const tool = readTool({
      "ai.toolCall.name": "search",
      "ai.toolCall.args": JSON.stringify({ query: "cats" }),
      "ai.toolCall.result": JSON.stringify({ count: 3 }),
    });
    expect(tool).toEqual({
      toolName: "search",
      input: { query: "cats" },
      output: { count: 3 },
    });
  });

  it("reads Traceloop's traceloop.entity.* attributes only when span.kind is tool", () => {
    expect(
      readTool({
        "traceloop.span.kind": "workflow",
        "traceloop.entity.name": "not-a-tool",
      }),
    ).toBeUndefined();

    const tool = readTool({
      "traceloop.span.kind": "tool",
      "traceloop.entity.name": "lookup",
      "traceloop.entity.input": "raw-input",
      "traceloop.entity.output": "raw-output",
    });
    expect(tool).toEqual({
      toolName: "lookup",
      input: "raw-input",
      output: "raw-output",
    });
  });

  it("reads the draft OTel GenAI gen_ai.tool.* attributes", () => {
    const tool = readTool({
      "gen_ai.tool.name": "get_weather",
      "gen_ai.tool.call.arguments": JSON.stringify({ city: "NYC" }),
    });
    expect(tool).toEqual({ toolName: "get_weather", input: { city: "NYC" } });
  });
});

describe("readLLM token fallbacks", () => {
  it("falls back to gen_ai.usage.{prompt,completion}_tokens", () => {
    const llm = readLLM({
      "gen_ai.usage.prompt_tokens": 7,
      "gen_ai.usage.completion_tokens": 3,
    });
    expect(llm?.promptTokens).toBe(7);
    expect(llm?.completionTokens).toBe(3);
    expect(llm?.totalTokens).toBe(10);
  });
});

describe("readLLM input and output", () => {
  it("reads the message list as the input and text as the output", () => {
    const llm = readLLM({
      "gen_ai.input.messages": JSON.stringify([
        { role: "user", content: "hi" },
      ]),
      "gen_ai.output.messages": JSON.stringify([{ content: "hello" }]),
    });
    expect(llm).toEqual({
      input: [{ role: "user", content: "hi" }],
      output: "hello",
    });
  });

  it("parses the output when gen_ai.output.type is json", () => {
    const llm = readLLM({
      "ai.response.text": JSON.stringify({ answer: 42 }),
      "gen_ai.output.type": "json",
    });
    expect(llm?.output).toEqual({ answer: 42 });
  });

  it("keeps JSON-looking text as text when no output type says otherwise", () => {
    const text = JSON.stringify({ answer: 42 });
    expect(readLLM({ "ai.response.text": text })?.output).toBe(text);
  });

  it("keeps json-typed output that doesn't parse as text", () => {
    const llm = readLLM({
      "ai.response.text": "{ truncated",
      "gen_ai.output.type": "json",
    });
    expect(llm?.output).toBe("{ truncated");
  });
});

describe("readLLM finish reason", () => {
  it("reads gen_ai.response.finish_reasons, joining multiple choices", () => {
    expect(
      readLLM({ "gen_ai.response.finish_reasons": ["stop"] })?.finishReason,
    ).toBe("stop");
    expect(
      readLLM({ "gen_ai.response.finish_reasons": ["stop", "length"] })
        ?.finishReason,
    ).toBe("stop, length");
  });

  it("falls back to the Vercel AI SDK's ai.response.finishReason", () => {
    expect(
      readLLM({ "ai.response.finishReason": "tool-calls" })?.finishReason,
    ).toBe("tool-calls");
  });

  it("omits the finish reason when none is reported", () => {
    expect(
      readLLM({ "gen_ai.request.model": "gpt-4o" })?.finishReason,
    ).toBeUndefined();
  });
});

describe("readLLM JSON input and output", () => {
  it("reads evalution.llm.input and evalution.llm.output as JSON", () => {
    const llm = readLLM({
      "gen_ai.provider.name": "typesafe",
      "evalution.llm.input": JSON.stringify({ state: "hi", questions: {} }),
      "evalution.llm.output": JSON.stringify({
        spam: { type: "noul", noul: 0.1 },
      }),
    });
    expect(llm).toMatchObject({
      provider: "typesafe",
      input: { state: "hi", questions: {} },
      output: { spam: { type: "noul", noul: 0.1 } },
    });
  });

  it("ignores malformed JSON attributes", () => {
    expect(readLLM({ "evalution.llm.output": "{ nope" })).toBeUndefined();
  });
});
