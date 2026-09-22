// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { DatasetSummary } from "../../../shared/types";
import { DatasetListHarness } from "./DatasetListHarness";

const DATASETS: DatasetSummary[] = [
  {
    providerId: "local",
    id: "tickets",
    name: "Tickets",
    rowCount: 12,
    fields: [],
    prompt: { id: "support" },
    updatedAt: 1_757_336_000_000,
  },
  {
    providerId: "local",
    id: "numbers",
    name: "Numbers",
    rowCount: 1,
    fields: [],
    updatedAt: 1_757_000_000_000,
  },
  {
    providerId: "local",
    id: "broken",
    name: "Broken",
    rowCount: 0,
    fields: [],
    updatedAt: 1_757_100_000_000,
    error: "not a SQLite database",
  },
];

test("medium width: cards show row count and linked prompt", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 260, height: 700 });
  const component = await mount(<DatasetListHarness datasets={DATASETS} />);

  await expect(component.locator(".trace-table")).toBeHidden();
  const tickets = component.locator(".trace-list-row", { hasText: "Tickets" });
  await expect(tickets).toContainText("12 rows");
  await expect(tickets).toContainText("Support reply");
  await expect(
    component.locator(".trace-list-row", { hasText: "Numbers" }),
  ).toContainText("1 row");
  await expect(
    component.locator(".trace-list-row", { hasText: "Broken" }),
  ).toContainText("can't be opened");
});

test("wide width: shows a sortable table instead of going blank", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 700 });
  const component = await mount(<DatasetListHarness datasets={DATASETS} />);

  await expect(component.locator(".trace-list-cards")).toBeHidden();
  await expect(component.locator(".trace-table")).toBeVisible();
  await expect(component.locator("thead th")).toHaveCount(4);

  const rowNames = () =>
    component.locator(".trace-table-row .trace-list-name").allTextContents();

  // Default: most recently updated first.
  await expect.poll(rowNames).toEqual(["Tickets", "Broken", "Numbers"]);

  const tickets = component.locator(".trace-table-row", { hasText: "Tickets" });
  await expect(tickets.locator(".trace-table-col-rowCount")).toHaveText("12");
  await expect(tickets.locator(".trace-table-col-prompt")).toHaveText(
    "Support reply",
  );
  await expect(
    component
      .locator(".trace-table-row", { hasText: "Numbers" })
      .locator(".trace-table-col-prompt"),
  ).toHaveText("—");

  // Sort by rows, descending — the unreadable dataset has no count, so it's last.
  await component
    .locator(".trace-table-col-rowCount")
    .first()
    .locator("button")
    .click();
  await expect.poll(rowNames).toEqual(["Tickets", "Numbers", "Broken"]);

  await tickets.click();
  await expect(tickets).toHaveClass(/trace-table-row-selected/);
});

test("the table-mode toggle widens the sidebar into table mode and back", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 700 });
  const component = await mount(
    <DatasetListHarness datasets={DATASETS} initialSidebarWidth={220} />,
  );

  await expect(component.locator(".trace-list-cards")).toBeVisible();
  const toggle = component.getByTitle("Toggle table view");
  await toggle.click();
  await expect(component.locator(".trace-table")).toBeVisible();
  await expect(component.locator(".trace-list-cards")).toBeHidden();

  await toggle.click();
  await expect(component.locator(".trace-table")).toBeHidden();
  await expect(component.locator(".trace-list-cards")).toBeVisible();
});
