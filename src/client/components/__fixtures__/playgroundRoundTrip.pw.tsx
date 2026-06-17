// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { getCursorOffset } from "./cursorTestUtils";
import { PlaygroundRoundTripHarness } from "./PlaygroundRoundTripHarness";

// Mock every /api/** endpoint the playground touches. The `update` endpoint
// echoes the posted updates after a short latency, with messages rebuilt as
// fresh objects — mirroring the real provider, which writes the source file and
// re-parses, so the echo is structurally distinct from what the client holds.
async function mockApi(page: Page, updateLatencyMs = 80) {
  await page.route("**/api/**", async route => {
    const url = route.request().url();
    if (url.includes("/update")) {
      const updates = route.request().postDataJSON();
      await new Promise(r => setTimeout(r, updateLatencyMs));
      const messages = (updates.messages ?? []).map((m: any) => ({
        role: m.role,
        content: { kind: m.content.kind, value: m.content.value },
      }));
      await route.fulfill({
        json: {
          id: "p1",
          providerId: "prov",
          name: "test",
          functionParameters: [],
          modelEditable: true,
          systemEditable: true,
          messages,
          messagesEditable: true,
          modelParameters: [],
          ...("system" in updates ? { system: updates.system } : {}),
        },
      });
      return;
    }
    if (url.includes("/models")) {
      await route.fulfill({ json: { models: [] } });
      return;
    }
    if (url.includes("/model-parameters")) {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

test("typing into a freshly added message (real round-trip) keeps order", async ({
  mount,
  page,
}) => {
  await mockApi(page);

  const component = await mount(<PlaygroundRoundTripHarness />);

  await component.getByText("Add message").click();

  const editor = component.locator(".token-editor").last();
  await editor.click();
  await editor.pressSequentially("Hi there", { delay: 30 });

  await expect(editor).toHaveText("Hi there");
});

test("adding a message focuses the new editor", async ({ mount, page }) => {
  await mockApi(page);

  const component = await mount(<PlaygroundRoundTripHarness />);

  await component.getByText("Add message").click();

  const editor = component.locator('[data-message-index="0"] .token-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.type("Hi");

  await expect(editor).toHaveText("Hi");
});

test("caret stays at the end when a save round-trip lands mid-typing", async ({
  mount,
  page,
}) => {
  await mockApi(page);

  const component = await mount(<PlaygroundRoundTripHarness />);

  await component.getByText("Add message").click();

  const editor = component.locator(".token-editor").last();
  await editor.click();
  await editor.press("H");
  // Let the in-flight round-trip from "Add message" resolve mid-edit.
  await page.waitForTimeout(140);
  await editor.press("i");

  await expect(editor).toHaveText("Hi");
  // The caret must follow the typed text, not jump back inside it.
  expect(await getCursorOffset(editor)).toBe(2);
});

test("caret stays at the end when the round-trip lands after typing", async ({
  mount,
  page,
}) => {
  await mockApi(page);

  const component = await mount(<PlaygroundRoundTripHarness />);

  await component.getByText("Add message").click();

  const editor = component.locator(".token-editor").last();
  await editor.click();
  await editor.press("H");
  await editor.press("i");
  // The "Add message" round-trip (carrying the stale empty message) resolves
  // only now, after both characters are in.
  await page.waitForTimeout(200);

  await expect(editor).toHaveText("Hi");
  expect(await getCursorOffset(editor)).toBe(2);
});

test("system editor keeps newer typing when an older save response lands", async ({
  mount,
  page,
}) => {
  await mockApi(page, 250);

  const component = await mount(
    <PlaygroundRoundTripHarness
      initialSystem={{ kind: "primitive", value: "" }}
    />,
  );

  const editor = component.locator(".token-editor").first();
  await editor.click();
  await editor.press("H");
  // Let the debounce send a save for "H", then type another character before
  // that older response comes back.
  await page.waitForTimeout(650);
  await editor.press("i");
  await page.waitForTimeout(300);

  await expect(editor).toHaveText("Hi");
  expect(await getCursorOffset(editor)).toBe(2);

  // The follow-up save for "Hi" should acknowledge without moving the caret.
  await page.waitForTimeout(700);
  await expect(editor).toHaveText("Hi");
  expect(await getCursorOffset(editor)).toBe(2);
});
