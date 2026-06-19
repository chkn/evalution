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

/** Simulates the server pushing a frame down the (stubbed) WebSocket. */
function emitServerMessage(
  page: import("@playwright/test").Page,
  message: Record<string, unknown>,
): Promise<void> {
  return page.evaluate(msg => {
    (window as any).__terminalWs?.onmessage?.({ data: JSON.stringify(msg) });
  }, message);
}

/** Launches the queued command by focusing the terminal and pressing Return. */
async function pressReturn(
  component: import("@playwright/test").Locator,
  page: import("@playwright/test").Page,
) {
  await component.locator(".terminal-view").click();
  await page.locator(".xterm-helper-textarea").press("Enter");
}

test("starts the PTY at the rendered terminal size", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <TerminalViewHarness width={600} height={400} />,
  );

  // Return launches the queued command, which sends the `start` message.
  await pressReturn(component, page);

  await expect.poll(() => findSent(page, "start")).toBeTruthy();
  const start = await findSent(page, "start");

  // The size must reflect the real container, not a zero/degenerate fallback
  // (which would make npm & friends hide their progress output).
  expect(start!.cols).toBeGreaterThan(20);
  expect(start!.rows).toBeGreaterThan(5);
});

test("shows a spinner after Return and clears it on first output", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <TerminalViewHarness width={600} height={400} />,
  );
  const terminal = component.locator(".terminal-view");

  await pressReturn(component, page);

  // The spinner is active while waiting for the command to make a sound.
  await expect(terminal).toHaveClass(/terminal-view-spinning/);

  // The first chunk of output retires the spinner.
  await emitServerMessage(page, { type: "data", data: "hello" });
  await expect(terminal).not.toHaveClass(/terminal-view-spinning/);
});

test("clears the spinner when the command exits before any output", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <TerminalViewHarness width={600} height={400} />,
  );
  const terminal = component.locator(".terminal-view");

  await pressReturn(component, page);
  await expect(terminal).toHaveClass(/terminal-view-spinning/);

  await emitServerMessage(page, { type: "exit", code: 0 });
  await expect(terminal).not.toHaveClass(/terminal-view-spinning/);
});

test("reconnects with the same session id after the socket drops mid-run", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <TerminalViewHarness width={600} height={400} />,
  );

  // Launch the command so a session is "running" and worth resuming.
  await pressReturn(component, page);
  await expect.poll(() => findSent(page, "start")).toBeTruthy();
  await emitServerMessage(page, { type: "data", data: "working..." });

  // Simulate the socket dropping (e.g. the server restarting itself once a
  // config file appears) without the command having exited.
  await page.evaluate(() => (window as any).__terminalWs.onclose?.({}));

  // The client opens a fresh socket to resume, reusing the same sessionId so
  // the server can re-attach the still-running PTY.
  await expect
    .poll(() => page.evaluate(() => (window as any).__wsUrls.length))
    .toBeGreaterThan(1);
  const urls: string[] = await page.evaluate(() => (window as any).__wsUrls);
  const sessionId = (u: string) => new URL(u).searchParams.get("sessionId");
  expect(sessionId(urls[0])).toBeTruthy();
  expect(sessionId(urls[1])).toBe(sessionId(urls[0]));
});

test("reports a larger size when the container grows", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <TerminalViewHarness width={600} height={400} />,
  );

  await pressReturn(component, page);
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
