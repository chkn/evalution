// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator, Page } from "@playwright/test";
import { formatCost } from "../trace/format.ts";
import { TraceViewHarness } from "./TraceViewHarness";

/** Switches to the Conversation tab — the chat section is only mounted while it's active. */
function openConversationTab(component: Locator) {
  return component.getByRole("button", { name: "Conversation" }).click();
}

/** Switches to the Spans tab — the waterfall/tree is only mounted while it's active. */
function openSpansTab(component: Locator) {
  return component.getByRole("button", { name: "Spans" }).click();
}

const TRACE = {
  trace: {
    id: "t1",
    providerId: "p1",
    name: "test run",
    startTime: 1000,
    endTime: 2000,
    status: "ok",
  },
  spans: [
    {
      id: "root",
      traceId: "t1",
      name: "agent",
      kind: "AGENT",
      startTime: 1000,
      endTime: 2000,
      status: "ok",
    },
    {
      id: "llm1",
      traceId: "t1",
      parentId: "root",
      name: "step: 0",
      kind: "LLM",
      startTime: 1000,
      endTime: 1500,
      status: "ok",
      llm: {
        provider: "openai",
        model: "gpt-4o",
        input: [{ role: "user", content: "Hello **world**" }],
        output: "Hi there!",
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
        // $5/1M prompt tokens, $50/1M completion tokens.
        cost: { prompt: 0.000015, completion: 0.00025 },
      },
    },
    {
      id: "tool1",
      traceId: "t1",
      parentId: "root",
      name: "tool: search",
      kind: "TOOL",
      startTime: 1500,
      endTime: 1800,
      status: "ok",
      tool: {
        toolName: "search",
        input: { query: "cats" },
        output: { count: 3 },
      },
    },
  ],
};

let nextAnnotationId = 1;

async function mockTraceApi(page: Page, initialAnnotations: unknown[] = []) {
  const annotations = [...initialAnnotations];

  await page.route("**/api/traces/*/*/events", route =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"connected"}\n\n',
    }),
  );

  await page.route("**/api/traces/*/*/annotations/*", route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const id = route.request().url().split("/").pop();
    const idx = annotations.findIndex((a: any) => a.id === id);
    if (idx >= 0) annotations.splice(idx, 1);
    return route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/api/traces/*/*/annotations", route => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      const annotation = {
        id: `a${nextAnnotationId++}`,
        traceId: "t1",
        kind: input.kind,
        note: input.note,
        source: "user",
        createdAt: Date.now(),
        ...(input.spanId && { spanId: input.spanId }),
      };
      annotations.push(annotation);
      return route.fulfill({ status: 201, json: annotation });
    }
    return route.fulfill({ json: annotations });
  });

  await page.route("**/api/traces/*/*", route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: TRACE });
  });
}

test("renders the trace header and waterfall rows", async ({ mount, page }) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);

  await expect(component.locator(".trace-view-title")).toContainText(
    "test run",
  );
  // Conversation is the default tab; switch to Spans to see the waterfall.
  await openSpansTab(component);
  await expect(component.locator(".trace-row")).toHaveCount(3);
  // No chevron/disclosure control — the whole row is the click target.
  await expect(component.locator(".trace-row-disclosure")).toHaveCount(0);
});

test("the Conversation and Spans tabs show exclusively one view, and the combine toggle only appears on the Spans tab", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);

  // Conversation is the default tab.
  await expect(component.locator(".trace-row")).toHaveCount(0);
  await expect(component.locator(".chat-turn")).toHaveCount(1);
  await expect(component.locator(".trace-spans-combined-toggle")).toHaveCount(
    0,
  );

  await openSpansTab(component);
  await expect(component.locator(".trace-row")).toHaveCount(3);
  await expect(component.locator(".chat-turn")).toHaveCount(0);
  await expect(component.locator(".trace-spans-combined-toggle")).toBeVisible();

  await openConversationTab(component);
  await expect(component.locator(".trace-row")).toHaveCount(0);
  await expect(component.locator(".chat-turn")).toHaveCount(1);
  await expect(component.locator(".trace-spans-combined-toggle")).toHaveCount(
    0,
  );
});

test("Combined mode groups same-named spans into one row with a segment per instance", async ({
  mount,
  page,
}) => {
  await page.route("**/api/traces/*/*/events", route =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"connected"}\n\n',
    }),
  );
  await page.route("**/api/traces/*/*/annotations", route =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/traces/*/*", route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        trace: {
          id: "t1",
          providerId: "p1",
          name: "repeated-calls",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
        spans: [
          {
            id: "root",
            traceId: "t1",
            name: "agent",
            kind: "AGENT",
            startTime: 1000,
            endTime: 2000,
            status: "ok",
          },
          {
            id: "call1",
            traceId: "t1",
            parentId: "root",
            name: "tool: search",
            kind: "TOOL",
            startTime: 1000,
            endTime: 1200,
            status: "ok",
            tool: { toolName: "search", input: { q: 1 }, output: {} },
          },
          {
            id: "call2",
            traceId: "t1",
            parentId: "root",
            name: "tool: search",
            kind: "TOOL",
            startTime: 1400,
            endTime: 1600,
            status: "ok",
            tool: { toolName: "search", input: { q: 2 }, output: {} },
          },
        ],
      },
    });
  });

  const component = await mount(<TraceViewHarness />);
  await openSpansTab(component);
  await component.getByRole("button", { name: "Group repeated spans" }).click();

  // Two "tool: search" calls plus the root collapse to two rows, not three.
  await expect(component.locator(".trace-row")).toHaveCount(2);
  const searchRow = component.locator(".trace-row", {
    hasText: "tool: search",
  });
  await expect(searchRow.locator(".trace-row-count-badge")).toHaveText("×2");
  await expect(searchRow.locator(".trace-combined-bar-segment")).toHaveCount(2);

  // Clicking a segment selects that specific call's details. The default
  // (wide) viewport shows them in the side pane rather than inline.
  await searchRow.locator(".trace-combined-bar-segment").first().click();
  await expect(component.locator(".trace-details-pane")).toContainText("call1");
});

test("selecting an LLM row shows its provider/model/token details in the details pane", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);
  await openSpansTab(component);

  await component
    .locator(".trace-row", { hasText: "step: 0" })
    .locator(".trace-row-main")
    .click();

  // Default (wide) viewport shows details in the side pane, not inline. The
  // message content itself isn't repeated here — that's the chat section's
  // job (see "renders the chat section below the tree" below).
  const details = component.locator(".trace-details-pane");
  await expect(details).toContainText("openai");
  await expect(details).toContainText("gpt-4o");
  await expect(details).toContainText("3 in · 5 out · 8 total");
  await expect(details).toContainText(
    `${formatCost(0.000265)} (${formatCost(0.000015)} in · ${formatCost(0.00025)} out)`,
  );
});

test("hovering the header's cost meta item reveals the prompt/completion breakdown and implied $/1M prices", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);

  const costMeta = component.locator(".trace-cost-meta");
  await expect(costMeta).toContainText(formatCost(0.000265));

  const tooltip = costMeta.locator(".trace-cost-tooltip");
  await expect(tooltip).toBeHidden();
  await costMeta.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(
    `Prompt (${formatCost(5)}/1M tok)${formatCost(0.000015)}`,
  );
  await expect(tooltip).toContainText(
    `Completion (${formatCost(50)}/1M tok)${formatCost(0.00025)}`,
  );
  await expect(tooltip).toContainText(`Total${formatCost(0.000265)}`);

  // Moving off the badge closes it again.
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
});

test("the cost tooltip stays inside the viewport when the badge sits near a narrow window's edge", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  await page.setViewportSize({ width: 380, height: 700 });
  const component = await mount(<TraceViewHarness />);

  const costMeta = component.locator(".trace-cost-meta");
  await costMeta.hover();
  const tooltip = costMeta.locator(".trace-cost-tooltip");
  await expect(tooltip).toBeVisible();

  const box = await tooltip.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(380);
});

test("the Conversation tab renders LLM turns as bubbles (not cards) and tool calls as cards", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);
  await openConversationTab(component);

  const llmTurn = component.locator(".chat-turn");
  await expect(llmTurn).toContainText("Hi there!");
  await expect(llmTurn.locator("strong")).toHaveText("world"); // markdown-rendered **world**
  // The input message and the output each render as their own bubble.
  await expect(llmTurn.locator(".chat-bubble")).toHaveCount(2);
  // LLM turns aren't cards; only the tool call renders with `.chat-block`.
  await expect(component.locator(".chat-flow > .chat-block")).toHaveCount(1);
  await expect(component.locator(".chat-block-tool")).toContainText("search");
});

test("chat section hides tool-role messages, since the adjacent TOOL span already shows them", async ({
  mount,
  page,
}) => {
  await page.route("**/api/traces/*/*/events", route =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"connected"}\n\n',
    }),
  );
  await page.route("**/api/traces/*/*/annotations", route =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/traces/*/*", route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        trace: {
          id: "t1",
          providerId: "p1",
          name: "tool-message",
          startTime: 1000,
          endTime: 1200,
          status: "ok",
        },
        spans: [
          {
            id: "root",
            traceId: "t1",
            name: "agent",
            kind: "AGENT",
            startTime: 1000,
            endTime: 1200,
            status: "ok",
          },
          {
            id: "tool1",
            traceId: "t1",
            parentId: "root",
            name: "tool: search",
            kind: "TOOL",
            startTime: 1000,
            endTime: 1050,
            status: "ok",
            tool: {
              toolName: "search",
              input: { query: "cats" },
              output: { count: 3 },
            },
          },
          {
            id: "llm1",
            traceId: "t1",
            parentId: "root",
            name: "step: 0",
            kind: "LLM",
            startTime: 1050,
            endTime: 1100,
            status: "ok",
            llm: {
              input: [
                { role: "user", content: "search for cats" },
                { role: "tool", content: "raw-tool-output-marker" },
              ],
              output: "I found 3 results.",
            },
          },
        ],
      },
    });
  });

  const component = await mount(<TraceViewHarness />);
  await openConversationTab(component);

  const llmTurn = component.locator(".chat-turn");
  // Only the user message and the output render — the tool-role message
  // (already shown by the TOOL span's card) is dropped.
  await expect(llmTurn.locator(".chat-bubble")).toHaveCount(2);
  await expect(llmTurn).not.toContainText("raw-tool-output-marker");
});

test("chat section keeps a tool call's arguments/result collapsed by default, but can expand them inline", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);
  await openConversationTab(component);

  const toolBlock = component.locator(".chat-block-tool");
  await expect(toolBlock).toContainText("search");
  await expect(toolBlock).toContainText("300ms");
  await expect(toolBlock).not.toContainText("cats");
  await expect(toolBlock).not.toContainText("count");

  await toolBlock.locator(".chat-block-expand-toggle").click();
  await expect(toolBlock).toContainText("cats");
  await expect(toolBlock).toContainText("count");

  // Clicking the card itself (not the expand toggle, and not a JSON row
  // inside the now-expanded section, which has its own click-to-collapse
  // behavior) selects the span and shows the same data in the details pane.
  await toolBlock.locator(".chat-block-label").click();
  const details = component.locator(".trace-details-pane");
  await expect(details).toContainText("cats");
});

test("chat section does not repeat an earlier turn's messages in a later turn", async ({
  mount,
  page,
}) => {
  await page.route("**/api/traces/*/*/events", route =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"connected"}\n\n',
    }),
  );
  await page.route("**/api/traces/*/*/annotations", route =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/traces/*/*", route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        trace: {
          id: "t1",
          providerId: "p1",
          name: "multi-turn",
          startTime: 1000,
          endTime: 1200,
          status: "ok",
        },
        spans: [
          {
            id: "root",
            traceId: "t1",
            name: "agent",
            kind: "AGENT",
            startTime: 1000,
            endTime: 1200,
            status: "ok",
          },
          {
            id: "llm1",
            traceId: "t1",
            parentId: "root",
            name: "step: 0",
            kind: "LLM",
            startTime: 1000,
            endTime: 1050,
            status: "ok",
            llm: {
              input: [{ role: "user", content: "first question" }],
              output: "first answer",
            },
          },
          {
            id: "llm2",
            traceId: "t1",
            parentId: "root",
            name: "step: 1",
            kind: "LLM",
            startTime: 1050,
            endTime: 1100,
            status: "ok",
            llm: {
              // Folds turn1's `output` back in as an assistant message, the
              // way a real multi-turn agent loop resends full history.
              input: [
                { role: "user", content: "first question" },
                { role: "assistant", content: "first answer" },
                { role: "user", content: "second question" },
              ],
              output: "second answer",
            },
          },
        ],
      },
    });
  });

  const component = await mount(<TraceViewHarness />);
  await openConversationTab(component);

  const turns = component.locator(".chat-turn");
  await expect(turns).toHaveCount(2);
  // Each turn shows only its own new input message plus its own output —
  // "first question" and "first answer" must not reappear in turn 2.
  await expect(turns.nth(0).locator(".chat-bubble")).toHaveCount(2);
  await expect(turns.nth(1).locator(".chat-bubble")).toHaveCount(2);
  await expect(turns.nth(1)).not.toContainText("first question");
  await expect(turns.nth(1)).not.toContainText("first answer");
  await expect(turns.nth(1)).toContainText("second question");
  await expect(turns.nth(1)).toContainText("second answer");
});

test("creates and then deletes a trace-level annotation", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);

  await component.locator(".trace-annotations-add").click();
  await component
    .locator(".annotation-form-kind-btn", { hasText: "issue" })
    .click();
  await component.locator(".annotation-form-note").fill("looks wrong");
  await component.locator(".annotation-form-submit").click();

  const card = component.locator(".annotation-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("looks wrong");

  await card.locator(".annotation-card-delete").click();
  await expect(component.locator(".annotation-card")).toHaveCount(0);
});

test("tool span details render args/result as an expandable JSON tree", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);
  await openSpansTab(component);

  await component
    .locator(".trace-row", { hasText: "tool: search" })
    .locator(".trace-row-main")
    .click();

  // Default (wide) viewport shows details in the side pane, not inline.
  const details = component.locator(".trace-details-pane");
  // maxExpand defaults to depth < 3, so the top-level object starts open.
  await expect(
    details.locator(".json-key", { hasText: "query" }),
  ).toBeVisible();
  await expect(
    details.locator(".json-string", { hasText: "cats" }),
  ).toBeVisible();

  // Collapsing the object hides its keys again.
  await details.locator(".json-row-collapsed").first().click();
  await expect(details.locator(".json-key", { hasText: "query" })).toBeHidden();
});

test("the header meta row hides the model, then the token count, as the header narrows, without any items overlapping", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  const component = await mount(<TraceViewHarness />);

  const model = component.locator(".trace-view-meta-model");
  const tokens = component.locator(".trace-view-meta-tokens");
  const spansItem = component.locator(".trace-view-meta-item", {
    hasText: "3 spans",
  });

  // Plenty of room: everything is visible.
  await expect(model).toBeVisible();
  await expect(tokens).toBeVisible();

  // Narrow enough to drop the model (<=550px), but tokens and the rest stay.
  await page.setViewportSize({ width: 500, height: 700 });
  await expect(model).toBeHidden();
  await expect(tokens).toBeVisible();
  await expect(spansItem).toBeVisible();

  // Narrower still (<=450px): tokens goes too.
  await page.setViewportSize({ width: 400, height: 700 });
  await expect(tokens).toBeHidden();
  await expect(spansItem).toBeVisible();

  // Whatever remains never wraps onto a second line and overlaps its
  // neighbor — every visible meta item's row stays within the meta bar's
  // own height.
  const metaBox = await component.locator(".trace-view-meta").boundingBox();
  const itemBoxes = await component
    .locator(".trace-view-meta-item")
    .evaluateAll(els =>
      els
        .filter(el => getComputedStyle(el).display !== "none")
        .map(el => el.getBoundingClientRect()),
    );
  for (const box of itemBoxes) {
    expect(box.y).toBeGreaterThanOrEqual(metaBox!.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(
      metaBox!.y + metaBox!.height + 1,
    );
  }
});

test("collapses header actions into a menu button when the header is narrow", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  await page.setViewportSize({ width: 380, height: 700 });
  const component = await mount(<TraceViewHarness />);

  await expect(
    component.locator(".trace-view-header-actions-full"),
  ).toBeHidden();
  const menuTrigger = component.locator(".trace-view-header-menu-trigger");
  await expect(menuTrigger).toBeVisible();

  await menuTrigger.click();
  const menu = page.locator(".trace-header-menu");
  await expect(menu).toBeVisible();

  await menu
    .locator(".trace-header-menu-item", { hasText: "Add annotation" })
    .click();
  await expect(
    component.locator(".annotation-form-kind-btn").first(),
  ).toBeVisible();
  await expect(menu).toBeHidden();
});

test("keeps header actions inline when the header is wide", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  const component = await mount(<TraceViewHarness />);

  await expect(
    component.locator(".trace-view-header-actions-full"),
  ).toBeVisible();
  await expect(
    component.locator(".trace-view-header-menu-trigger"),
  ).toBeHidden();
});

test("renders an image content part as an <img>, validated through toSafeImageSrc", async ({
  mount,
  page,
}) => {
  await page.route("**/api/traces/*/*/events", route =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"connected"}\n\n',
    }),
  );
  await page.route("**/api/traces/*/*/annotations", route =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/traces/*/*", route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        trace: {
          id: "t1",
          providerId: "p1",
          name: "img",
          startTime: 1000,
          endTime: 1100,
          status: "ok",
        },
        spans: [
          {
            id: "llm1",
            traceId: "t1",
            name: "vision",
            kind: "LLM",
            startTime: 1000,
            endTime: 1100,
            status: "ok",
            llm: {
              input: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "what is this?" },
                    {
                      type: "image",
                      image: "https://example.com/cat.png",
                      mediaType: "image/png",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
  });

  const component = await mount(<TraceViewHarness />);
  await openConversationTab(component);

  // The selected span's details pane doesn't repeat message content — this
  // only ever renders in the Conversation tab's chat section. Must be the
  // safe, validated src.
  const img = component.locator(".message-image");
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute("src", "https://example.com/cat.png");
});

test("shows span details in a bottom pane when narrow, and in a side pane once there's room", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  await page.setViewportSize({ width: 480, height: 700 });
  const component = await mount(<TraceViewHarness />);
  await openSpansTab(component);

  const row = component.locator(".trace-row", { hasText: "step: 0" });
  await row.locator(".trace-row-main").click();
  await expect(component.locator(".trace-details-bottom-pane")).toContainText(
    "gpt-4o",
  );
  await expect(component.locator(".trace-details-pane")).toHaveCount(0);

  // Same selection, more room: the side pane takes over and the bottom copy
  // goes away — the two are mutually exclusive, not both shown at once.
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(component.locator(".trace-details-pane")).toContainText(
    "gpt-4o",
  );
  await expect(component.locator(".trace-details-bottom-pane")).toHaveCount(0);

  // The bottom pane is visible from either tab, not just Spans.
  await page.setViewportSize({ width: 480, height: 700 });
  await openConversationTab(component);
  await expect(component.locator(".trace-details-bottom-pane")).toContainText(
    "gpt-4o",
  );
});

test("clicking anywhere on a row (not just an icon) selects its span", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);
  await openSpansTab(component);

  await component.locator(".trace-row-name", { hasText: "step: 0" }).click();

  await expect(
    component.locator(".trace-row", { hasText: "step: 0" }),
  ).toHaveClass(/trace-row-selected/);
  await expect(component.locator(".trace-details-pane")).toContainText(
    "gpt-4o",
  );
});

/** A trace with `n` LLM turns under one root — enough rows/messages to overflow both the span list and the chat, so their scrolling and selection sync can be tested. */
async function mockManyTurnsTrace(page: Page, n: number) {
  await page.route("**/api/traces/*/*/events", route =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"connected"}\n\n',
    }),
  );
  await page.route("**/api/traces/*/*/annotations", route =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/traces/*/*", route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        trace: {
          id: "t1",
          providerId: "p1",
          name: "many-turns",
          startTime: 0,
          endTime: n * 100,
          status: "ok",
        },
        spans: [
          {
            id: "root",
            traceId: "t1",
            name: "agent",
            kind: "AGENT",
            startTime: 0,
            endTime: n * 100,
            status: "ok",
          },
          ...Array.from({ length: n }, (_, i) => ({
            id: `llm${i}`,
            traceId: "t1",
            parentId: "root",
            name: `step: ${i}`,
            kind: "LLM",
            startTime: i * 100,
            endTime: i * 100 + 50,
            status: "ok",
            llm: {
              input: [{ role: "user", content: `question ${i}` }],
              output: `answer ${i}`,
            },
          })),
        ],
      },
    });
  });
}

test("the span list and the chat region each scroll independently within their own tab", async ({
  mount,
  page,
}) => {
  await mockManyTurnsTrace(page, 25);
  const component = await mount(<TraceViewHarness />);
  await openSpansTab(component);

  const list = component.locator(".trace-timeline-list");
  await expect(component.locator(".trace-row")).toHaveCount(26);
  await list.evaluate(el => {
    el.scrollTop = 100;
  });
  await expect(list).toHaveJSProperty("scrollTop", 100);

  // Switching tabs unmounts the span list — its scroll position isn't
  // expected to survive that, only to be independent of the chat's.
  await openConversationTab(component);
  const chat = component.locator(".trace-chat-region");
  await expect(component.locator(".chat-turn")).toHaveCount(25);
  await chat.evaluate(el => {
    el.scrollTop = 100;
  });
  await expect(chat).toHaveJSProperty("scrollTop", 100);
});

test("selecting a span in one tab scrolls to and highlights it in the other, once switched to", async ({
  mount,
  page,
}) => {
  await mockManyTurnsTrace(page, 25);
  const component = await mount(<TraceViewHarness />);

  // Select on the Spans tab, then switch to Conversation: the matching turn
  // is already scrolled into view and highlighted, the reverse direction of
  // `ChatFlow`'s own scroll-to-selection effect (see `TraceView`).
  await openSpansTab(component);
  await component
    .locator(".trace-row", { hasText: "step: 20" })
    .locator(".trace-row-main")
    .click();
  await openConversationTab(component);
  const farTurn = component.locator('.chat-turn[data-span-id="llm20"]');
  await expect(farTurn).toHaveClass(/chat-turn-selected/);
  await expect(farTurn).toBeInViewport();

  // Clicking a different message selects its span; switching back to Spans
  // scrolls that row to the top of the list (or as close as it can scroll).
  const otherTurn = component.locator('.chat-turn[data-span-id="llm5"]');
  await otherTurn.click();
  await openSpansTab(component);
  const otherRow = component.locator('.trace-row[data-span-id="llm5"]');
  await expect(otherRow).toHaveClass(/trace-row-selected/);
  // Scroll is animated (`scrollIntoView({ behavior: "smooth" })`), so poll.
  await expect(async () => {
    const listBox = await component
      .locator(".trace-timeline-list")
      .boundingBox();
    const rowBox = await otherRow.boundingBox();
    expect(rowBox!.y).toBeLessThan(listBox!.y + 40);
  }).toPass();
});

test("the details pane spans the full tab height, regardless of which tab is active", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);
  await openConversationTab(component);
  await expect(component.locator(".trace-row")).toHaveCount(0);
  await expect(component.locator(".trace-timeline-list")).toHaveCount(0);

  await component.locator(".chat-turn").click();
  await expect(component.locator(".trace-details-pane")).toContainText(
    "gpt-4o",
  );

  const bodyBox = await component.locator(".trace-view-body").boundingBox();
  const paneBox = await component.locator(".trace-details-pane").boundingBox();
  expect(Math.abs(paneBox!.height - bodyBox!.height)).toBeLessThan(2);
});
