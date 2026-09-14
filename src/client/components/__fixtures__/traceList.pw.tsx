// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { TraceSummary } from "../../../shared/types";
import { TraceListHarness } from "./TraceListHarness";

const ONE_TRACE: TraceSummary[] = [
  {
    id: "t1",
    providerId: "p1",
    name: "first run",
    startTime: 1_757_336_000_000,
    endTime: 1_757_336_020_610,
    status: "ok",
    spanCount: 8,
  },
];

const compactTimestamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

test("medium width: cards show the same compact date/time format and icons as the trace header", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 260, height: 700 });
  const component = await mount(<TraceListHarness traces={ONE_TRACE} />);

  await expect(component.locator(".trace-table")).toBeHidden();
  const meta = component
    .locator(".trace-list-row")
    .locator(".trace-list-meta-item");
  await expect(meta).toHaveCount(3);

  for (let i = 0; i < 3; i++) {
    await expect(meta.nth(i).locator("svg")).toHaveCount(1);
  }

  await expect(meta.nth(0)).toContainText(
    compactTimestamp(ONE_TRACE[0]!.startTime),
  );
  await expect(meta.nth(1)).toContainText("8 spans");
  await expect(meta.nth(2)).toContainText("20.61s");
});

test("narrow width: the meta row disappears instead of wrapping", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 150, height: 700 });
  const component = await mount(<TraceListHarness traces={ONE_TRACE} />);

  await expect(component.locator(".trace-table")).toBeHidden();
  await expect(component.locator(".trace-list-row-top")).toBeVisible();
  await expect(component.locator(".trace-list-row-meta")).toBeHidden();
});

test("clicking a narrow or medium card still selects its trace", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 260, height: 700 });
  const component = await mount(<TraceListHarness traces={ONE_TRACE} />);

  await component.locator(".trace-list-row").click();
  await expect(component.locator(".trace-list-row")).toHaveClass(
    /trace-list-row-selected/,
  );
});

test.describe("wide width: sortable table", () => {
  const TRACES: TraceSummary[] = [
    {
      id: "old-small",
      providerId: "p1",
      name: "old and small",
      startTime: 1_757_000_000_000,
      endTime: 1_757_000_001_000, // 1s
      status: "ok",
      spanCount: 2,
    },
    {
      id: "new-big",
      providerId: "p1",
      name: "new and big",
      startTime: 1_757_336_000_000,
      endTime: 1_757_336_020_610, // 20.61s
      status: "ok",
      spanCount: 20,
    },
    {
      id: "running",
      providerId: "p1",
      name: "still running",
      startTime: 1_757_200_000_000,
      status: "running",
      spanCount: 5,
    },
  ];

  test("shows a table with icon-only headers, no cards, and no redundant 'spans' word", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);

    await expect(component.locator(".trace-list-cards")).toBeHidden();
    await expect(component.locator(".trace-table")).toBeVisible();

    // Header icons, one per icon-only sortable column, plus the sortable
    // text-label "Name" header.
    await expect(component.locator("thead th")).toHaveCount(4);
    await expect(component.locator("thead th").first()).toHaveText("Name");
    const sortHeaders = component.locator(".trace-table-th");
    await expect(sortHeaders).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(sortHeaders.nth(i).locator("svg")).toHaveCount(1);
    }

    // Rows show the span count as a bare number, not "N spans".
    const firstRow = component.locator(".trace-table-row").first();
    await expect(firstRow).not.toContainText("span");
  });

  test("defaults to newest-first, and clicking a header sorts by it", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);

    const rowNames = () =>
      component.locator(".trace-table-row .trace-list-name").allTextContents();

    // Default: startTime desc — newest first, running trace (no endTime) in the middle by date.
    await expect
      .poll(rowNames)
      .toEqual(["new and big", "still running", "old and small"]);

    // Sort by spans (header order: Name, Date, Spans, Duration).
    await component.locator(".trace-table-th").nth(1).locator("button").click();
    await expect.poll(rowNames).toEqual([
      "new and big", // 20 spans
      "still running", // 5 spans
      "old and small", // 2 spans
    ]);

    // Click again reverses to ascending.
    await component.locator(".trace-table-th").nth(1).locator("button").click();
    await expect
      .poll(rowNames)
      .toEqual(["old and small", "still running", "new and big"]);
  });

  test("clicking the Name header sorts alphabetically", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);
    const rowNames = () =>
      component.locator(".trace-table-row .trace-list-name").allTextContents();

    // First click defaults to descending, like every other column.
    await component.locator(".trace-table-name-th").locator("button").click();
    await expect
      .poll(rowNames)
      .toEqual(["still running", "old and small", "new and big"]);

    // Click again reverses to ascending.
    await component.locator(".trace-table-name-th").locator("button").click();
    await expect
      .poll(rowNames)
      .toEqual(["new and big", "old and small", "still running"]);
  });

  test("a still-running trace (no duration) always sorts last", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);
    const rowNames = () =>
      component.locator(".trace-table-row .trace-list-name").allTextContents();

    // Sort by duration, descending then ascending — "still running" stays last either way.
    await component.locator(".trace-table-th").nth(2).locator("button").click();
    await expect
      .poll(rowNames)
      .toEqual(["new and big", "old and small", "still running"]);
    await component.locator(".trace-table-th").nth(2).locator("button").click();
    await expect
      .poll(rowNames)
      .toEqual(["old and small", "new and big", "still running"]);
  });

  test("clicking a row selects its trace", async ({ mount, page }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);

    const row = component.locator(".trace-table-row", {
      hasText: "new and big",
    });
    await row.click();
    await expect(row).toHaveClass(/trace-table-row-selected/);
  });
});
