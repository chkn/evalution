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

test("typing ${ opens the dropdown with interpolatables + the literal action", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${");

  const items = component.locator(".te-suggest-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText(/name/);
  await expect(items.nth(1)).toHaveText(/config/);
  await expect(items.nth(2)).toHaveText("Insert as literal text");
});

test("Enter accepts the suggestion and closes it into a token", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${");
  await page.keyboard.press("Enter"); // accept "name" + close

  await expect(editor.locator(".te-token")).toHaveText("${name}");
  await expect(component.locator(".te-suggest")).toHaveCount(0);
});

test("Tab accepts without closing; } then commits the token", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${na");
  await page.keyboard.press("Tab"); // accept "name", stay open → ${name
  await expect(editor.locator(".te-token")).toHaveCount(0);
  await page.keyboard.type("}"); // commit
  await expect(editor.locator(".te-token")).toHaveText("${name}");
});

test("space commits the token right after accepting a suggestion", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${");
  await page.keyboard.press("Tab"); // accept "name", flag set
  await page.keyboard.type(" "); // space closes the token

  await expect(editor.locator(".te-token")).toHaveText("${name}");
  await expect(editor).toContainText("${name} ");
});

test("space does NOT commit when the expression was typed freely", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${name"); // typed, not accepted → flag clear
  await page.keyboard.type(" "); // stays literal

  await expect(editor.locator(".te-token")).toHaveCount(0);
  await expect(editor).toContainText("${name ");
});

test("typing } still creates a token after dismissing the dropdown with Escape", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${");
  await page.keyboard.press("Tab"); // accept "name", stay open → ${name
  await page.keyboard.press("Escape"); // dismiss the suggestion popup
  await page.keyboard.type("}"); // close the interpolation

  await expect(editor.locator(".te-token")).toHaveText("${name}");
});

test("drills into object children, then Enter commits the nested token", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${");
  await page.keyboard.press("ArrowDown"); // highlight "config"
  await page.keyboard.press("Tab"); // accept "config", stay open → ${config

  await page.keyboard.type("."); // reopen with children
  const items = component.locator(".te-suggest-item");
  await expect(items.nth(0)).toHaveText(/name/);
  await expect(items.nth(1)).toHaveText(/age/);

  await page.keyboard.type("a"); // filter to "age"
  await page.keyboard.press("Enter"); // accept "age" + close

  await expect(editor.locator(".te-token")).toHaveText("${config.age}");
});

test("typing after a committed token's } keeps the token highlighted", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${");
  await page.keyboard.press("Enter"); // accept "name" + close → ${name}
  await expect(editor.locator(".te-token")).toHaveText("${name}");

  // Typing right after the closing brace must not dissolve the token: the
  // browser folds the char into the editable span (`${name}.`), and fromHTML
  // has to split the trailing literal back out instead of losing the highlight.
  await page.keyboard.type(".");
  await expect(editor.locator(".te-token")).toHaveText("${name}");
  await expect(editor).toContainText("${name}.");
});

test("Escape closes the dropdown", async ({ mount, page }) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${");
  await expect(component.locator(".te-suggest")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(component.locator(".te-suggest")).toHaveCount(0);
});

test("without interpolatables, typing ${foo} still creates a token", async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness withParams={false} />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${foo");

  // Dropdown offers the insert-token / literal actions when there are no suggestions.
  const items = component.locator(".te-suggest-item");
  await expect(items.nth(0)).toHaveText("Insert token");
  await expect(items.nth(1)).toHaveText("Insert as literal text");

  await page.keyboard.type("}");
  await expect(editor.locator(".te-token")).toHaveText("${foo}");
});

test('choosing "insert as literal text" keeps the text literal', async ({
  mount,
  page,
}) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness withParams={false} />);
  const editor = component.locator(".token-editor").nth(1);

  await editor.click();
  await page.keyboard.type("${foo");
  await page.keyboard.press("ArrowDown"); // highlight "Insert as literal text"
  await page.keyboard.press("Enter"); // accept literal

  await expect(component.locator(".te-suggest")).toHaveCount(0);
  await expect(editor.locator(".te-token")).toHaveCount(0);
  await expect(editor).toContainText("${foo");

  // The dropdown stays suppressed for this construct, so } stays literal too.
  await page.keyboard.type("}");
  await expect(editor.locator(".te-token")).toHaveCount(0);
});
