// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { DatasetAddColumnHarness } from "./DatasetAddColumnHarness";

test("the New field form stays inside the window when it widens the popover", async ({
  mount,
  page,
}) => {
  await mount(<DatasetAddColumnHarness />);
  await page.getByRole("button", { name: "Add column" }).click();
  const popover = page.getByRole("dialog", { name: "Add column" });
  await page.getByRole("button", { name: "New field…" }).click();
  await expect(page.getByLabel("Field type")).toBeVisible();
  // The form is wider than the menu it replaced; the popover follows.
  await expect
    .poll(async () => {
      const box = await popover.boundingBox();
      return box ? box.x + box.width : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
});
