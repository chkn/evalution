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

async function mockApi(
  page: Page,
  updateLatencyMs: number | ((call: number) => number) = 80,
) {
  let updateCalls = 0;
  await page.route("**/api/**", async route => {
    const url = route.request().url();
    if (url.includes("/update")) {
      const updates = route.request().postDataJSON();
      const latency =
        typeof updateLatencyMs === "number"
          ? updateLatencyMs
          : updateLatencyMs(updateCalls++);
      await new Promise(r => setTimeout(r, latency));
      const messages = (updates.messages ?? []).map((m: any) => ({
        role: m.role,
        content: { kind: m.content.kind, value: m.content.value },
      }));
      await route.fulfill({
        json: {
          prompt: {
            id: "p1",
            providerId: "prov",
            name: "test",
            functionParameters: [],
            style: "chat",
            modelEditable: true,
            systemEditable: true,
            messages,
            messagesEditable: true,
            modelParameters: [],
            ...("system" in updates ? { system: updates.system } : {}),
          },
          ref: { promptId: "p1" },
        },
      });
      return;
    }
    if (url.includes("/model-definition")) {
      await route.fulfill({ json: null });
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

test("a stale echo landing between keystrokes doesn't drop typed text (firefox)", async ({
  mount,
  page,
}) => {
  // Pins the race the timing-based test above only hits under load: the
  // "Add message" echo (empty) lands after "H" is typed, while the "H" echo is
  // still in flight when "i" is typed. Applying that stale echo would wipe "H".
  await mockApi(page, call => (call === 0 ? 250 : 1000));

  const component = await mount(<PlaygroundRoundTripHarness />);

  await component.getByText("Add message").click();

  const editor = component.locator(".token-editor").last();
  await editor.click();
  await editor.press("H");
  await page.waitForTimeout(400);
  await editor.press("i");

  await expect(editor).toHaveText("Hi");
  // Outlast the slow echoes, so none of them can still overwrite the text.
  await page.waitForTimeout(1200);
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
