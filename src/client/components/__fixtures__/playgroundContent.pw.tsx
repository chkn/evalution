// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";
import {
  PlaygroundContentHarness,
  SavedVariationHarness,
  VersionRefHarness,
} from "./PlaygroundContentHarness";
import { SAVED_VARIATION_ID, savedVariationPrompt } from "./saved-variation";

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

test("a saved variation shows read-only, with the way to edit it", async ({
  mount,
  page,
}) => {
  await page.route("**/api/**", async route => {
    const url = route.request().url();
    if (url.includes(`variation=${SAVED_VARIATION_ID}`)) {
      await route.fulfill({ json: savedVariationPrompt });
    } else if (url.includes("/model-parameters")) {
      await route.fulfill({ json: [] });
    } else {
      await route.fulfill({ json: null });
    }
  });
  const component = await mount(<SavedVariationHarness />);

  const banner = component.getByRole("status");
  await expect(banner).toContainText(
    "Viewing keeper. Saved variations are read-only.",
  );
  await expect(
    banner.getByRole("button", { name: "Open on working tree" }),
  ).toBeVisible();

  const editor = component.locator(".pg-editor-col");
  await expect(editor).toContainText("Be brief");
  await expect(editor.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: /Add message/ }),
  ).toBeDisabled();
});

test("a version that can't be opened says why, and goes back to head", async ({
  mount,
  page,
}) => {
  const version = "f4e8ebab3cc3c59e285aa71e4634807221dcffa3";
  await page.route("**/api/**", async route => {
    const url = route.request().url();
    if (url.includes(`version=${version}`)) {
      await route.fulfill({ status: 404, json: { error: "Prompt not found" } });
    } else if (url.includes("/model-parameters")) {
      await route.fulfill({ json: [] });
    } else {
      await route.fulfill({ json: null });
    }
  });
  const component = await mount(<VersionRefHarness version={version} />);

  await expect(component.getByTestId("tab-ref")).toHaveText("head");
  await expect(component.locator(".pg-header-error")).toContainText(
    "Can't open f4e8eba: Prompt not found",
  );
});
