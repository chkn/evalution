// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { InterpolationHarness } from "./InterpolationHarness";

async function mockApiRoutes(page: Page) {
  await page.route("**/models", route =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route("**/model-parameters", route => route.fulfill({ json: [] }));
  await page.route("**/update", async route => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      json: {
        id: "test",
        name: "test",
        functionParameters: [],
        modelEditable: true,
        system: body.system ?? { kind: "primitive", value: "" },
        systemEditable: true,
        messages: Array.isArray(body.messages) ? body.messages : [],
        messagesEditable: true,
        modelParameters: [],
      },
    });
  });
}

// .nth(0) = system editor, .nth(1) = first message editor

test("backtick-delimited text is wrapped in a monospace code span", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("call `myFunc()` now");

  await expect(editor.locator(".te-code")).toHaveText("`myFunc()`");
  await expect(editor).toContainText("call `myFunc()` now");
});

test("unclosed backtick stays literal, not highlighted", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("this has a stray ` backtick");

  await expect(editor.locator(".te-code")).toHaveCount(0);
  await expect(editor).toContainText("this has a stray ` backtick");
});

test("backticks survive further edits after the span (round-trips through fromHTML)", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("`code`");
  await expect(editor.locator(".te-code")).toHaveText("`code`");

  // Typing right after the span must not drop the backticks or the highlight.
  await page.keyboard.type(" more");
  await expect(editor.locator(".te-code")).toHaveText("`code`");
  await expect(editor).toContainText("`code` more");
});
