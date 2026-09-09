// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { TraceViewHarness } from "./TraceViewHarness";

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
        messages: [{ role: "user", content: "Hello **world**" }],
        output: "Hi there!",
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
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
  await expect(component.locator(".trace-row")).toHaveCount(3);
});

test("expanding an LLM row renders its message (markdown) and output", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);

  await component
    .locator(".trace-row", { hasText: "step: 0" })
    .locator(".trace-row-disclosure")
    .click();

  const details = component.locator(".trace-row-details");
  await expect(details.locator("strong")).toHaveText("world"); // markdown-rendered **world**
  await expect(details).toContainText("Hi there!");
});

test("switching to the Chat tab renders LLM and tool chat blocks", async ({
  mount,
  page,
}) => {
  await mockTraceApi(page);
  const component = await mount(<TraceViewHarness />);

  await component.locator(".trace-view-tab", { hasText: "Chat" }).click();
  await expect(component.locator(".chat-block-llm")).toContainText("Hi there!");
  await expect(component.locator(".chat-block-tool")).toContainText("search");
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

  await component
    .locator(".trace-row", { hasText: "tool: search" })
    .locator(".trace-row-disclosure")
    .click();

  const details = component.locator(".trace-row-details");
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
              messages: [
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
  await component.locator(".trace-row-disclosure").click();

  const img = component.locator(".message-image");
  await expect(img).toHaveAttribute("src", "https://example.com/cat.png");
});
