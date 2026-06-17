// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { StrictMode } from "react";
import { getCursorOffset } from "./cursorTestUtils";
import { PlaygroundRoundTripHarness } from "./PlaygroundRoundTripHarness";

// Firefox handles contentEditable selection differently from Chromium: a
// re-render that touches the editor mid-typing can drop the caret back. These
// caret-position regressions only reproduce here, so the test is scoped to it.
test.use({ browserName: "firefox" });

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

test("caret stays at the end while typing into a freshly added message (firefox)", async ({
  mount,
  page,
}) => {
  // Long latency so the "Add message" round-trip is still in flight when the
  // first character is typed, landing its stale (empty) echo between keystrokes.
  await mockApi(page, 250);

  const component = await mount(<PlaygroundRoundTripHarness />);

  await component.getByText("Add message").click();

  const editor = component.locator(".token-editor").last();
  await editor.click();
  await editor.press("H");
  await page.waitForTimeout(300);
  await editor.press("i");

  await expect(editor).toHaveText("Hi");
  expect(await getCursorOffset(editor)).toBe(2);
});

test("caret stays put when the round-trip lands after both chars (firefox)", async ({
  mount,
  page,
}) => {
  await mockApi(page, 250);

  const component = await mount(<PlaygroundRoundTripHarness />);

  await component.getByText("Add message").click();

  const editor = component.locator(".token-editor").last();
  await editor.click();
  await editor.press("H");
  await editor.press("i");
  // The slow "Add message" echo resolves only now, after both chars are in.
  await page.waitForTimeout(300);

  await expect(editor).toHaveText("Hi");
  expect(await getCursorOffset(editor)).toBe(2);
});

test("caret survives the round-trip under StrictMode (firefox)", async ({
  mount,
  page,
}) => {
  await mockApi(page, 250);

  const component = await mount(
    <StrictMode>
      <PlaygroundRoundTripHarness />
    </StrictMode>,
  );

  await component.getByText("Add message").click();

  const editor = component.locator(".token-editor").last();
  await editor.click();
  await editor.press("H");
  await page.waitForTimeout(300);
  await editor.press("i");

  await expect(editor).toHaveText("Hi");
  expect(await getCursorOffset(editor)).toBe(2);
});
