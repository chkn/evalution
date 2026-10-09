// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { ResourcesSectionHarness } from "./ResourcesSectionHarness";

test("an instance's actions sit behind a menu, not inline", async ({
  mount,
  page,
}) => {
  const component = await mount(<ResourcesSectionHarness />);
  const trigger = component.getByRole("button", { name: "Actions for db" });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(
    component.getByRole("button", { name: "Duplicate" }),
  ).toHaveCount(0);
  await expect(
    component.getByRole("button", { name: "Remove db" }),
  ).toHaveCount(0);

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // The menu is portaled to the body, outside the mounted component.
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Duplicate", "Remove"]);
});

test("a server-scoped instance can be removed but not duplicated", async ({
  mount,
  page,
}) => {
  const component = await mount(<ResourcesSectionHarness />);
  await component.getByRole("button", { name: "Actions for cache" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Remove"]);
});

test("Duplicate adds a copy and closes the menu", async ({ mount, page }) => {
  const component = await mount(<ResourcesSectionHarness />);
  await component.getByRole("button", { name: "Actions for db" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Duplicate" })
    .click();

  await expect(component.getByTestId("names")).toHaveText("db,db2,cache");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("Remove clears the instance once confirmed", async ({ mount, page }) => {
  const component = await mount(<ResourcesSectionHarness />);
  await component.getByRole("button", { name: "Actions for db" }).click();
  page.once("dialog", dialog => dialog.accept());
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Remove db" })
    .click();

  await expect(component.getByTestId("names")).toHaveText("cache");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("cancelling Remove keeps the instance", async ({ mount, page }) => {
  const component = await mount(<ResourcesSectionHarness />);
  await component.getByRole("button", { name: "Actions for db" }).click();
  page.once("dialog", dialog => dialog.dismiss());
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Remove db" })
    .click();

  await expect(component.getByTestId("names")).toHaveText("db,cache");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("a click outside the open menu closes it", async ({ mount, page }) => {
  const component = await mount(<ResourcesSectionHarness />);
  await component.getByRole("button", { name: "Actions for db" }).click();
  await expect(page.getByRole("menu")).toBeVisible();

  await page.mouse.click(1, 1);
  await expect(page.getByRole("menu")).toHaveCount(0);
});
