// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Span } from "../../../shared/types";
import { makeSpan } from "./__fixtures__/spans.ts";
import { ChatFlow } from "./ChatFlow.tsx";
import { buildRows } from "./rows.ts";

const render = (spans: Span[]) =>
  renderToStaticMarkup(
    createElement(ChatFlow, {
      rows: buildRows(spans),
      selectedSpanId: null,
      onSelectSpan: () => {},
      annotations: [],
    }),
  );

describe("ChatFlow", () => {
  it("shows a turn's reasoning collapsed, ahead of its answer", () => {
    const html = render([
      makeSpan("turn", {
        kind: "LLM",
        llm: { reasoning: "They said hi.", output: "Hello!" },
      }),
    ]);
    expect(html).toMatch(
      /<details class="message-reasoning">.*They said hi\..*<\/details>.*Hello!/s,
    );
  });

  it("shows the reasoning of a turn with no output", () => {
    const html = render([
      makeSpan("turn", { kind: "LLM", llm: { reasoning: "Hmm." } }),
    ]);
    expect(html).toContain("Hmm.");
    expect(html).not.toContain("chat-bubble-role-assistant");
  });

  it("shows nothing for a turn without reasoning", () => {
    const html = render([
      makeSpan("turn", { kind: "LLM", llm: { output: "Hello!" } }),
    ]);
    expect(html).not.toContain("message-reasoning");
  });

  it("opens with the user prompt an agent span was given", () => {
    const html = render([
      makeSpan("agent", {
        kind: "AGENT",
        llm: { input: [{ role: "user", content: "Explore the repo." }] },
      }),
      makeSpan("turn", {
        kind: "LLM",
        parentId: "agent",
        startTime: 1,
        llm: { output: "On it." },
      }),
    ]);
    expect(html).toContain("chat-bubble-role-user");
    expect(html.indexOf("Explore the repo.")).toBeLessThan(
      html.indexOf("On it."),
    );
  });

  it("doesn't repeat the user prompt a later turn re-sends", () => {
    const prompt = { role: "user", content: "Explore the repo." };
    const html = render([
      makeSpan("agent", { kind: "AGENT", llm: { input: [prompt] } }),
      makeSpan("turn", {
        kind: "LLM",
        parentId: "agent",
        startTime: 1,
        llm: { input: [prompt], output: "On it." },
      }),
    ]);
    expect(html.split("Explore the repo.")).toHaveLength(2);
  });
});
