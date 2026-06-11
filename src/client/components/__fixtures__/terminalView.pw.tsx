// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { TerminalViewHarness } from "./TerminalViewHarness";

interface ClientMessage {
  type: string;
  cols?: number;
  rows?: number;
}

/** Reads the JSON messages the terminal client has sent (see the harness). */
function sentMessages(
  page: import("@playwright/test").Page,
): Promise<ClientMessage[]> {
  return page.evaluate(() => (window as any).__terminalSent as ClientMessage[]);
}

async function findSent(page: import("@playwright/test").Page, type: string) {
  const messages = await sentMessages(page);
  return messages.find(m => m.type === type);
}

test("starts the PTY at the rendered terminal size", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <TerminalViewHarness width={600} height={400} />,
  );

  // Return launches the queued command, which sends the `start` message.
  await component.locator(".terminal-view").click();
  await page.locator(".xterm-helper-textarea").press("Enter");

  await expect.poll(() => findSent(page, "start")).toBeTruthy();
  const start = await findSent(page, "start");

  // The size must reflect the real container, not a zero/degenerate fallback
  // (which would make npm & friends hide their progress output).
  expect(start!.cols).toBeGreaterThan(20);
  expect(start!.rows).toBeGreaterThan(5);
});

test("reports a larger size when the container grows", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <TerminalViewHarness width={600} height={400} />,
  );

  await component.locator(".terminal-view").click();
  await page.locator(".xterm-helper-textarea").press("Enter");
  await expect.poll(() => findSent(page, "start")).toBeTruthy();
  const start = await findSent(page, "start");

  // Widening the container should fit the terminal wider and report it upstream.
  await component.getByTestId("grow").click();
  await expect
    .poll(async () => {
      const resize = await findSent(page, "resize");
      return resize ? resize.cols! > start!.cols! : false;
    })
    .toBe(true);
});
