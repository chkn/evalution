// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { copyText, messageText } from "./copy-text.ts";

describe("copyText", () => {
  it("copies a string as itself and anything else as pretty JSON", () => {
    expect(copyText("Hi **there**")).toBe("Hi **there**");
    expect(copyText({ query: "cats" })).toBe('{\n  "query": "cats"\n}');
    expect(copyText(3)).toBe("3");
  });

  it("copies undefined as text rather than nothing", () => {
    expect(copyText(undefined)).toBe("undefined");
  });
});

describe("messageText", () => {
  it("copies string content as itself", () => {
    expect(messageText("Hello")).toBe("Hello");
  });

  it("joins text and tool parts a paragraph apart, leaving out images and reasoning", () => {
    expect(
      messageText([
        { type: "reasoning", text: "Thinking." },
        { type: "text", text: "Looking it up." },
        { type: "image", image: "https://example.com/a.png" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "search",
          input: { q: "cats" },
        },
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: "3 cats",
        },
      ]),
    ).toBe('Looking it up.\n\n{\n  "q": "cats"\n}\n\n3 cats');
  });
});
