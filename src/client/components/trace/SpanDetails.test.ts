// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Span } from "../../../shared/types";
import { makeSpan } from "./__fixtures__/spans.ts";
import { SpanDetails } from "./SpanDetails.tsx";

const render = (span: Span) =>
  renderToStaticMarkup(
    createElement(SpanDetails, {
      span,
      annotations: [],
      freshIds: new Set<string>(),
      onClearFresh: () => {},
      onCreateAnnotation: async () => {},
      onDeleteAnnotation: async () => {},
    }),
  );

describe("SpanDetails", () => {
  it("shows an LLM span's input messages, tool calls and results included, and its output", () => {
    const html = render(
      makeSpan("step", {
        kind: "LLM",
        llm: {
          input: [
            { role: "user", content: "Plan task t-1." },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "seed",
                  toolName: "get_task",
                  input: { taskId: "t-1" },
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "seed",
                  toolName: "get_task",
                  output: { title: "Ship it" },
                },
              ],
            },
          ],
          output: "Planned.",
        },
      }),
    );
    expect(html).toContain(">Input<");
    expect(html).toContain("Plan task t-1.");
    expect(html).toMatch(/Call <code>get_task<\/code>/);
    expect(html).toContain("t-1");
    expect(html).toMatch(/Result from <code>get_task<\/code>/);
    expect(html).toContain("Ship it");
    expect(html).toContain(">Output<");
    expect(html).toContain("Planned.");
  });

  it("shows a non-message input as JSON, and no output row when there is none", () => {
    const html = render(
      makeSpan("eval", {
        kind: "LLM",
        llm: { input: { state: "s", questions: [] }, output: "" },
      }),
    );
    expect(html).toContain(">Input<");
    expect(html).toContain("questions");
    expect(html).not.toContain(">Output<");
  });
});
