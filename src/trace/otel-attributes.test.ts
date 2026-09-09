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
