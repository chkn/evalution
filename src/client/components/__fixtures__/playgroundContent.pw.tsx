// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";
import { PlaygroundContentHarness } from "./PlaygroundContentHarness";

const rect = (loc: Locator) =>
  loc.evaluate(el => {
    const { top, bottom, left, right } = el.getBoundingClientRect();
    return { top, bottom, left, right };
  });

test("narrow pane docks the execution pane at the bottom", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundContentHarness width={400} height={500} messagesCount={1} />,
  );
  const editor = await rect(component.locator(".pg-editor-col"));
  const exec = await rect(component.locator(".pg-exec-col"));
  // Stacked vertically: exec sits below the editor, sharing the left edge.
  expect(exec.top).toBeGreaterThanOrEqual(editor.bottom - 1);
  expect(exec.left).toBeCloseTo(editor.left, 0);
});

test("wide pane docks the execution pane on the right", async ({ mount }) => {
  const component = await mount(
    <PlaygroundContentHarness width={900} height={500} messagesCount={1} />,
  );
  const editor = await rect(component.locator(".pg-editor-col"));
  const exec = await rect(component.locator(".pg-exec-col"));
  // Side by side: exec sits to the right of the editor, sharing the top edge.
  expect(exec.left).toBeGreaterThanOrEqual(editor.right - 1);
  expect(exec.top).toBeCloseTo(editor.top, 0);
});

test("execute panel scrolls its params instead of overflowing the column", async ({
  mount,
}) => {
  const manyParams = Array.from({ length: 20 }, (_, i) => ({
    name: `param${i}`,
    type: {
      kind: "primitive" as const,
      syntax: "string",
      base: "string" as const,
    },
    optional: false,
  }));
  const component = await mount(
    <PlaygroundContentHarness
      width={900}
      height={500}
      messagesCount={1}
      functionParameters={manyParams}
    />,
  );

  const col = component.locator(".pg-exec-col");
  const body = component.locator(".pg-exec-body");
  const footer = component.locator(".pg-exec-footer");

  const colRect = await rect(col);
  const footerRect = await rect(footer);
  // The column itself never grows past its container...
  expect(colRect.bottom).toBeLessThanOrEqual(500 + 1);
  // ...and the Run button stays pinned at the bottom, not pushed off-screen.
  expect(footerRect.bottom).toBeLessThanOrEqual(500 + 1);

  // The params overflow, so the body — not the whole column — scrolls.
  const overflowing = await body.evaluate(
    el => el.scrollHeight > el.clientHeight + 1,
  );
  expect(overflowing).toBe(true);
});
