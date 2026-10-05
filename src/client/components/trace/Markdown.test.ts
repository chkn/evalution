// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const render = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, null, text));

describe("Markdown", () => {
  it("shows a single newline as a line break", () => {
    expect(render("first\nsecond")).toMatch(/first<br\/>\s*second/);
  });

  it("still separates blank-line-delimited paragraphs", () => {
    const html = render("first\n\nsecond");
    expect(html).toContain("<p>first</p>");
    expect(html).toContain("<p>second</p>");
    expect(html).not.toContain("<br");
  });

  it("keeps line breaks inside list items", () => {
    expect(render("- one\n  still one\n- two")).toMatch(
      /one<br\/>\s*still one/,
    );
  });

  it("leaves other Markdown formatting intact", () => {
    const html = render(
      "**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toMatch(/<code [^>]*>code<\/code>/);
    expect(html).toContain("<table>");
  });
});
