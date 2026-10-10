// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { PromptRefChipHarness } from "./PromptRefChipHarness";
import { SAVED_VARIATION_ID, savedVariationPrompt } from "./saved-variation";

const KEEPER = savedVariationPrompt.variation!;

/** Serves the prompt's variations and history; returns the requests made to a variation. */
async function mockVariations(page: Page) {
  const requests: { method: string; url: string; body?: unknown }[] = [];
  let names = [...KEEPER.names];
  await page.route("**/api/prompts/**/variations", route =>
    route.fulfill({ json: names.length ? [{ ...KEEPER, names }] : [] }),
  );
  await page.route("**/api/prompts/**/versions*", route =>
    route.fulfill({ json: [] }),
  );
  await page.route(`**/api/variations/test/${SAVED_VARIATION_ID}/**`, route => {
    const request = route.request();
    const body = request.postDataJSON() ?? undefined;
    requests.push({ method: request.method(), url: request.url(), body });
    if (request.url().endsWith("/rename")) {
      if (body.to === "taken") {
        return route.fulfill({
          status: 400,
          json: { error: 'A variation named "taken" already exists' },
        });
      }
      names = [body.to];
      return route.fulfill({ json: { ...KEEPER, names } });
    }
    names = [];
    return route.fulfill({ status: 204 });
  });
  return requests;
}

test("renames a variation in place from the ref menu", async ({
  mount,
  page,
}) => {
  const requests = await mockVariations(page);
  const component = await mount(<PromptRefChipHarness />);
  await component.getByRole("button", { name: /Working tree/ }).click();
  const menu = page.getByRole("menu");
  await menu.getByText("keeper").hover();
  await menu.getByRole("button", { name: "Rename keeper" }).click();

  const input = menu.getByLabel("Variation name");
  await expect(input).toHaveValue("keeper");
  // Escape leaves the rename, not the menu.
  await input.press("Escape");
  await expect(input).toBeHidden();
  await expect(menu).toBeVisible();

  await menu.getByText("keeper").hover();
  await menu.getByRole("button", { name: "Rename keeper" }).click();
  await input.fill("taken");
  await input.press("Enter");
  await expect(menu.getByText(/already exists/)).toBeVisible();

  await input.fill("kept");
  await input.press("Enter");
  await expect(menu.getByRole("menuitem", { name: /kept/ })).toBeVisible();
  await expect(input).toBeHidden();
  expect(requests.at(-1)).toMatchObject({
    method: "POST",
    body: { from: "keeper", to: "kept" },
  });
});

test("deletes a variation after confirming, and leaves it if it was open", async ({
  mount,
  page,
}) => {
  const requests = await mockVariations(page);
  const component = await mount(
    <PromptRefChipHarness
      initial={{ promptId: "test", variation: SAVED_VARIATION_ID }}
    />,
  );
  await component.getByRole("button", { name: /keeper/ }).click();
  const menu = page.getByRole("menu");
  const row = menu.getByRole("menuitem", { name: /keeper/ });

  // Declining leaves it be.
  page.once("dialog", dialog => dialog.dismiss());
  await row.hover();
  await menu.getByRole("button", { name: "Delete keeper" }).click();
  await expect(row).toBeVisible();
  expect(requests).toEqual([]);

  page.once("dialog", dialog => dialog.accept());
  await row.hover();
  await menu.getByRole("button", { name: "Delete keeper" }).click();
  await expect(component.getByTestId("selected")).toHaveText("head");
  expect(requests).toEqual([
    expect.objectContaining({
      method: "DELETE",
      url: expect.stringMatching(/\/name\/keeper$/),
    }),
  ]);
});
