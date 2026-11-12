// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator, Page } from "@playwright/test";
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
    annotationCounts: { issue: 0, good: 0, note: 0 },
  },
];

const compactTimestamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Clicks the checkbox in the open column picker's row for `label` (e.g. "Tokens"). */
async function toggleColumnByLabel(page: Page, label: string) {
  await page
    .locator(".trace-column-picker-row", { hasText: label })
    .locator('input[type="checkbox"]')
    .click();
}

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
      annotationCounts: { issue: 0, good: 0, note: 0 },
    },
    {
      id: "new-big",
      providerId: "p1",
      name: "new and big",
      startTime: 1_757_336_000_000,
      endTime: 1_757_336_020_610, // 20.61s
      status: "ok",
      spanCount: 20,
      annotationCounts: { issue: 0, good: 0, note: 0 },
    },
    {
      id: "running",
      providerId: "p1",
      name: "still running",
      startTime: 1_757_200_000_000,
      status: "running",
      spanCount: 5,
      annotationCounts: { issue: 0, good: 0, note: 0 },
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

test.describe("table-mode toggle", () => {
  test("widens the sidebar into table mode, and restores its width on a second click", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 700 });
    const component = await mount(
      <TraceListHarness traces={ONE_TRACE} initialSidebarWidth={220} />,
    );

    // Narrower than the table breakpoint (325px) — starts in card mode.
    await expect(component.locator(".trace-table")).toBeHidden();
    await expect(component.locator(".trace-list-cards")).toBeVisible();

    const toggle = component.getByTitle("Toggle table view");
    await toggle.click();
    await expect(component.locator(".trace-table")).toBeVisible();
    await expect(component.locator(".trace-list-cards")).toBeHidden();

    await toggle.click();
    await expect(component.locator(".trace-table")).toBeHidden();
    await expect(component.locator(".trace-list-cards")).toBeVisible();
  });

  test("remembers which mode it's in across a remount", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 700 });
    const component = await mount(
      <TraceListHarness traces={ONE_TRACE} initialSidebarWidth={220} />,
    );
    await component.getByTitle("Toggle table view").click();
    await component.unmount();

    const remounted = await mount(
      <TraceListHarness traces={ONE_TRACE} initialSidebarWidth={340} />,
    );
    const toggle = remounted.getByTitle("Toggle table view");
    // The mode it was in is remembered, so this goes to the other one.
    await toggle.click();
    expect(
      await remounted.evaluate(el => (el as HTMLElement).style.width),
    ).toBe("220px");
  });

  test("the first width to go to is sized to the visible columns, capped at a max", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 700 });
    const component = await mount(
      <TraceListHarness traces={ONE_TRACE} initialSidebarWidth={220} />,
    );
    const toggle = component.getByTitle("Toggle table view");

    // Show every column — comfortably over the 480px cap, so it clamps down to it.
    await component.getByTitle("Columns").click();
    const popover = page.locator(".trace-column-picker");
    for (const label of ["Tokens", "Model", "Cost", "Annotations"]) {
      await popover
        .locator(".trace-column-picker-row", { hasText: label })
        .locator('input[type="checkbox"]')
        .click();
    }
    await page.keyboard.press("Escape");

    await toggle.click();
    expect(
      await component.evaluate(el => (el as HTMLElement).style.width),
    ).toBe("480px");
  });

  test("the first width to go to is at least the table's minimum", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 700 });
    const component = await mount(
      <TraceListHarness traces={ONE_TRACE} initialSidebarWidth={220} />,
    );
    // Default columns (Date/Spans/Duration): 92 + 40 + 60 + 120 (Name) + 24
    // (chrome) = 336, clamped up to the 340px minimum.
    await component.getByTitle("Toggle table view").click();
    expect(
      await component.evaluate(el => (el as HTMLElement).style.width),
    ).toBe("340px");
  });
});

test.describe("column customization", () => {
  const TRACES: TraceSummary[] = [
    {
      id: "alpha",
      providerId: "p1",
      name: "alpha run",
      startTime: 1_757_000_000_000,
      endTime: 1_757_000_005_000,
      status: "ok",
      spanCount: 3,
      totalTokens: 1234,
      model: "gpt-4o",
      cost: 0.0123,
      annotationCounts: { issue: 2, good: 1, note: 0 },
    },
    {
      id: "beta",
      providerId: "p1",
      name: "beta run",
      startTime: 1_757_000_010_000,
      endTime: 1_757_000_012_000,
      status: "ok",
      spanCount: 1,
      annotationCounts: { issue: 0, good: 0, note: 0 },
    },
  ];

  test("Tokens, Model, Cost, and Annotations start hidden, and can be shown via the column picker", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);

    // Name + the original 3 (Date, Spans, Duration).
    await expect(component.locator("thead th")).toHaveCount(4);

    await component.getByTitle("Columns").click();
    await toggleColumnByLabel(page, "Tokens");
    await toggleColumnByLabel(page, "Model");
    await toggleColumnByLabel(page, "Cost");
    await toggleColumnByLabel(page, "Annotations");
    await page.keyboard.press("Escape");

    await expect(component.locator("thead th")).toHaveCount(8);
    await expect(component.locator(".trace-table-col-totalTokens")).toHaveCount(
      3,
    ); // th + 2 rows
    await expect(component.locator(".trace-table-col-model")).toHaveCount(3);
    await expect(component.locator(".trace-table-col-cost")).toHaveCount(3);
  });

  test("the Tokens/Model/Cost columns render their values, or an em dash when the trace has none", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);
    await component.getByTitle("Columns").click();
    await toggleColumnByLabel(page, "Tokens");
    await toggleColumnByLabel(page, "Model");
    await toggleColumnByLabel(page, "Cost");
    await page.keyboard.press("Escape");

    const alphaRow = component.locator(".trace-table-row", {
      hasText: "alpha run",
    });
    await expect(alphaRow.locator(".trace-table-col-totalTokens")).toHaveText(
      "1,234",
    );
    await expect(alphaRow.locator(".trace-table-col-model")).toHaveText(
      "gpt-4o",
    );
    await expect(alphaRow.locator(".trace-table-col-cost")).toHaveText(
      "$0.012", // formatCost(0.0123) — see trace/format.ts
    );

    const betaRow = component.locator(".trace-table-row", {
      hasText: "beta run",
    });
    await expect(betaRow.locator(".trace-table-col-totalTokens")).toHaveText(
      "—",
    );
    await expect(betaRow.locator(".trace-table-col-model")).toHaveText("—");
    await expect(betaRow.locator(".trace-table-col-cost")).toHaveText("—");
  });

  test("the Annotations column shows a colored count badge per nonzero kind, or an em dash when empty", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);
    await component.getByTitle("Columns").click();
    await toggleColumnByLabel(page, "Annotations");
    await page.keyboard.press("Escape");

    const alphaCell = component
      .locator(".trace-table-row", { hasText: "alpha run" })
      .locator(".trace-table-col-annotations");
    await expect(alphaCell.locator(".annotation-chip-issue")).toHaveText("!2");
    await expect(alphaCell.locator(".annotation-chip-good")).toHaveText("✓1");
    await expect(alphaCell.locator(".annotation-chip-note")).toHaveCount(0);

    const betaCell = component
      .locator(".trace-table-row", { hasText: "beta run" })
      .locator(".trace-table-col-annotations");
    await expect(betaCell.locator(".trace-annotation-counts-empty")).toHaveText(
      "—",
    );
  });

  test("dragging a column's grab handle reorders it, reflected immediately in the table", async ({
    mount,
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);

    const columnOrder = () =>
      component
        .locator("thead th")
        .evaluateAll(ths =>
          ths.map(
            th =>
              [...th.classList]
                .find(c => c.startsWith("trace-table-col-"))
                ?.replace("trace-table-col-", "") ?? "name",
          ),
        );

    await expect
      .poll(columnOrder)
      .toEqual(["name", "startTime", "spanCount", "duration"]);

    await component.getByTitle("Columns").click();
    const popover = page.locator(".trace-column-picker");
    const rows = popover.locator(".trace-column-picker-row");

    // Drag "Duration" (index 2) above "Date" (index 0).
    await rows
      .nth(2)
      .locator(".trace-column-picker-grab")
      .dragTo(rows.nth(0).locator(".trace-column-picker-grab"));

    await page.keyboard.press("Escape");

    await expect
      .poll(columnOrder)
      .toEqual(["name", "duration", "startTime", "spanCount"]);
  });
});

test.describe("row height at the smallest layout", () => {
  /** A row's total height, and how far its name row sits from the row's own top edge. */
  function measureRow(locator: Locator) {
    return locator.locator(".trace-list-row").evaluate(row => {
      const rowRect = row.getBoundingClientRect();
      const topRect = row
        .querySelector(".trace-list-row-top")!
        .getBoundingClientRect();
      return { height: rowRect.height, nameOffset: topRect.top - rowRect.top };
    });
  }

  test("matches the wider card layout's row height — and its content's vertical position — when its meta row is empty (all columns hidden)", async ({
    mount,
    page,
  }) => {
    // Medium width: the meta row is still laid out (not `display: none`),
    // but empty once every column is hidden — its wrapping div stays a flex
    // item, so it still opens up the `.trace-list-row` gap before it.
    await page.setViewportSize({ width: 260, height: 700 });
    const wide = await mount(<TraceListHarness traces={ONE_TRACE} />);
    await wide.getByTitle("Columns").click();
    for (const label of ["Date", "Spans", "Duration"]) {
      await toggleColumnByLabel(page, label);
    }
    await page.keyboard.press("Escape");
    // Not `display: none` (that's the narrow layout's job) — just empty, so
    // Playwright's `toBeVisible` (which also requires a non-zero box) doesn't apply.
    await expect(wide.locator(".trace-list-row-meta")).toHaveCSS(
      "display",
      "flex",
    );
    await expect(wide.locator(".trace-list-row-meta")).toBeEmpty();
    const wideRow = await measureRow(wide);
    await wide.unmount();

    // Narrow width: the meta row is dropped (`display: none`) outright,
    // regardless of which columns are enabled.
    await page.setViewportSize({ width: 150, height: 700 });
    const narrow = await mount(<TraceListHarness traces={ONE_TRACE} />);
    await expect(narrow.locator(".trace-list-row-meta")).toBeHidden();
    const narrowRow = await measureRow(narrow);

    expect(narrowRow.height).toBe(wideRow.height);
    // Not just the same overall height — the extra space belongs below the
    // name row (where the empty meta row would have been), not split evenly
    // around it, or the name row visibly shifts down relative to the wider
    // layout even though the row height matches.
    expect(narrowRow.nameOffset).toBe(wideRow.nameOffset);
  });
});

test("the Checks column shows a trace's outcome counts, and a group's total", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.evaluate(() =>
    localStorage.setItem(
      "trace-list-columns",
      JSON.stringify([{ key: "checks", visible: true }]),
    ),
  );
  const evalRun = {
    providerId: "ev",
    evalId: "e1",
    evalName: "Answers eval",
    runId: "r1",
    startedAt: 1_757_336_000_000,
    armId: "a1",
    armLabel: "Working tree",
  };
  const trace = (id: string, overrides: Partial<TraceSummary>) => ({
    id,
    providerId: "p1",
    name: `answer ${id}`,
    startTime: 1_757_336_000_000,
    endTime: 1_757_336_000_500,
    status: "ok" as const,
    spanCount: 2,
    annotationCounts: { issue: 0, good: 0, note: 0 },
    ...overrides,
  });
  const counts = { pass: 0, fail: 0, error: 0, skipped: 0, scored: 0 };
  const component = await mount(
    <TraceListHarness
      traces={[
        trace("solo", {}),
        trace("cats", {
          evalRun,
          checkCounts: { ...counts, pass: 2, fail: 1 },
        }),
        trace("dogs", { evalRun, checkCounts: { ...counts, pass: 1 } }),
      ]}
    />,
  );

  const rows = component.locator(".trace-table-row");
  const group = rows.filter({ hasText: "Answers eval" });
  await expect(group.locator("[title='pass']")).toHaveText("✓3");
  await expect(group.locator("[title='fail']")).toHaveText("✗1");
  await expect(
    rows
      .filter({ hasText: "answer solo" })
      .locator(".trace-annotation-counts-empty"),
  ).toHaveText("—");

  await group.click();
  const cats = rows.filter({ hasText: "answer cats" });
  await expect(cats.locator("[title='pass']")).toHaveText("✓2");
  await expect(cats.locator("[title='fail']")).toHaveText("✗1");
});

test.describe("eval-run groups", () => {
  const evalRun = {
    providerId: "ev",
    evalId: "e1",
    evalName: "Answers eval",
    runId: "r1",
    startedAt: 1_757_336_000_000,
    armId: "a1",
    armLabel: "Working tree",
  };
  const TRACES: TraceSummary[] = [
    {
      id: "solo",
      providerId: "p1",
      name: "playground run",
      startTime: 1_757_400_000_000,
      endTime: 1_757_400_001_000,
      status: "ok",
      spanCount: 1,
      annotationCounts: { issue: 0, good: 0, note: 0 },
    },
    ...["cats", "dogs"].map(
      (id, i): TraceSummary => ({
        id,
        providerId: "p1",
        name: `answer ${id}`,
        startTime: 1_757_336_000_000 + i * 1000,
        endTime: 1_757_336_000_500 + i * 1000,
        status: "ok",
        spanCount: 2,
        annotationCounts: { issue: 0, good: 0, note: 0 },
        evalRun,
      }),
    ),
  ];

  for (const [layout, width, rowClass] of [
    ["cards", 260, ".trace-list-row"],
    ["table", 420, ".trace-table-row"],
  ] as const) {
    test(`${layout}: a run's traces start collapsed under one row, and expand indented`, async ({
      mount,
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      const component = await mount(<TraceListHarness traces={TRACES} />);
      const rows = component.locator(rowClass);
      const group = rows.filter({ hasText: "Answers eval" });

      await expect(rows).toHaveCount(2);
      await expect(group).toHaveAttribute("aria-expanded", "false");
      await expect(group.locator(".trace-list-group-count")).toHaveText("2");

      await group.click();
      await expect(group).toHaveAttribute("aria-expanded", "true");
      await expect(rows).toHaveCount(4);
      const children = component.locator(`${rowClass}-child`);
      await expect(children).toHaveCount(2);

      // Indented: a child's name starts right of its group's.
      const groupX = (await group.locator(".trace-list-name").boundingBox())!.x;
      const childX = (await children
        .first()
        .locator(".trace-list-name")
        .boundingBox())!.x;
      expect(childX).toBeGreaterThan(groupX);

      // A child selects its trace; the group itself never is selected.
      await children.first().click();
      await expect(children.first()).toHaveClass(/-selected/);
      await expect(group).not.toHaveClass(/-selected/);

      await group.click();
      await expect(rows).toHaveCount(2);
    });
  }
});

test("a stretch of playground runs starts collapsed under one Playground row", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 700 });
  const traces: TraceSummary[] = [2, 1].map(i => ({
    id: `p${i}`,
    providerId: "p1",
    name: `run ${i}`,
    startTime: 1_757_336_000_000 + i * 1000,
    endTime: 1_757_336_000_500 + i * 1000,
    status: "ok",
    spanCount: 1,
    annotationCounts: { issue: 0, good: 0, note: 0 },
    environment: "playground",
  }));
  const component = await mount(<TraceListHarness traces={traces} />);
  const rows = component.locator(".trace-table-row");

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Playground");
  await expect(rows.first()).toHaveAttribute("title", "Playground — 2 runs");
  await rows.first().click();
  await expect(component.locator(".trace-table-row-child")).toHaveCount(2);
});

test.describe("search, filters and grouping", () => {
  const DAY = 86_400_000;
  // Noon on the local clock, so each trace's day is the same in any zone.
  const NOON = new Date(2026, 8, 8, 12).getTime();
  const trace = (
    id: string,
    name: string,
    fields: Partial<TraceSummary> = {},
  ): TraceSummary => ({
    id,
    providerId: "p1",
    name,
    startTime: NOON,
    endTime: NOON + 500,
    status: "ok",
    spanCount: 1,
    annotationCounts: { issue: 0, good: 0, note: 0 },
    ...fields,
  });
  const TRACES: TraceSummary[] = [
    trace("t1", "summarize ticket", { model: "gpt-5", cost: 0.02 }),
    trace("t2", "summarize email", {
      model: "gpt-5",
      cost: 0.5,
      startTime: NOON - DAY,
      endTime: NOON - DAY + 8000,
      status: "error",
    }),
    trace("t3", "answer question", {
      model: "claude",
      startTime: NOON - 40 * DAY,
      endTime: NOON - 40 * DAY + 500,
    }),
    trace("t4", "classify", { startTime: NOON - 2 * DAY, endTime: undefined }),
  ];

  const mountList = async (
    mount: Parameters<Parameters<typeof test>[2]>[0]["mount"],
    page: Page,
  ) => {
    await page.setViewportSize({ width: 420, height: 700 });
    const component = await mount(<TraceListHarness traces={TRACES} />);
    const rows = component.locator(".trace-table-row");
    await expect(rows).toHaveCount(4);
    return { component, rows };
  };
  const names = (rows: Locator) => rows.locator(".trace-list-name");

  test("searching lists the traces whose name matches, and says when none does", async ({
    mount,
    page,
  }) => {
    const { component, rows } = await mountList(mount, page);
    // The search is hidden until its toggle is clicked.
    await expect(component.getByRole("searchbox")).toHaveCount(0);
    await component.getByRole("button", { name: "Toggle search" }).click();
    const search = component.getByRole("searchbox", { name: "Search traces" });

    await search.fill("SUMMAR");
    await expect(names(rows)).toHaveText([
      "summarize ticket",
      "summarize email",
    ]);

    await search.fill("nothing like this");
    await expect(component.getByText("No traces match.")).toBeVisible();
    // The search box is still there to change it, and so is a way out.
    await expect(search).toBeVisible();
    await component
      .getByRole("button", { name: "Clear search and filters" })
      .click();
    await expect(rows).toHaveCount(4);
    await expect(search).toHaveValue("");
  });

  test("Esc in the search box clears the search and hides the box", async ({
    mount,
    page,
  }) => {
    const { component, rows } = await mountList(mount, page);
    const toggle = component.getByRole("button", { name: "Toggle search" });
    await toggle.click();
    const search = component.getByRole("searchbox", { name: "Search traces" });
    await expect(search).toBeFocused();

    await search.fill("email");
    await expect(rows).toHaveCount(1);

    await search.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(rows).toHaveCount(4);

    // Toggling off with the button clears the search as well.
    await toggle.click();
    await component.getByRole("searchbox").fill("email");
    await expect(rows).toHaveCount(1);
    await toggle.click();
    await expect(component.getByRole("searchbox")).toHaveCount(0);
    await expect(rows).toHaveCount(4);
  });

  test("the filter and group menus mark the columns that have an icon", async ({
    mount,
    page,
  }) => {
    const { component } = await mountList(mount, page);
    const icon = (row: Locator) => row.locator(".trace-menu-row-icon svg");

    await component.getByTitle("Filter").click();
    const filterRows = page.locator(".trace-filter-popover .trace-menu-row");
    await expect(icon(filterRows.filter({ hasText: "Date" }))).toHaveCount(1);
    await expect(icon(filterRows.filter({ hasText: "Model" }))).toHaveCount(1);
    // Name has none, but keeps its text lined up with the others.
    await expect(icon(filterRows.filter({ hasText: "Name" }))).toHaveCount(0);
    await page.keyboard.press("Escape");

    await component.getByTitle("Group by").click();
    const groupRows = page.getByRole("menuitemradio");
    await expect(icon(groupRows.filter({ hasText: "Cost" }))).toHaveCount(1);
    await expect(icon(groupRows.filter({ hasText: "Runs" }))).toHaveCount(0);
    await expect(icon(groupRows.filter({ hasText: "Status" }))).toHaveCount(0);
  });

  test("filtering by a text column offers its values, with counts", async ({
    mount,
    page,
  }) => {
    const { component, rows } = await mountList(mount, page);

    await component.getByTitle("Filter").click();
    await page.locator(".trace-filter-popover").getByText("Model").click();
    const values = page.locator(".trace-filter-value");
    await expect(values).toHaveText(["gpt-52", "claude1", "No model1"]);

    await values.filter({ hasText: "gpt-5" }).click();
    await expect(names(rows)).toHaveText([
      "summarize ticket",
      "summarize email",
    ]);
    await values.filter({ hasText: "No model" }).click();
    await expect(rows).toHaveCount(3);

    const chip = component.locator(".trace-filter-chip");
    await expect(chip).toHaveText(/Model: gpt-5, No model/);
    await page.keyboard.press("Escape");
    await chip.getByRole("button").click();
    await expect(chip).toHaveCount(0);
    await expect(rows).toHaveCount(4);
  });

  test("filtering by a number column takes a least and a most", async ({
    mount,
    page,
  }) => {
    const { component, rows } = await mountList(mount, page);

    await component.getByTitle("Filter").click();
    const popover = page.locator(".trace-filter-popover");
    await popover.getByText("Duration").click();
    const least = popover.getByLabel("At least (seconds)");
    await least.fill("5");
    await least.press("Enter");

    // The 8-second trace; not the one still running, which has no duration.
    await expect(names(rows)).toHaveText(["summarize email"]);
    await expect(component.locator(".trace-filter-chip")).toHaveText(
      /Duration: ≥ 5s/,
    );

    // Back at the columns, the filter shows against its column.
    await popover.getByRole("button", { name: "Back to columns" }).click();
    await expect(
      popover.locator(".trace-menu-row", { hasText: "Duration" }),
    ).toContainText("≥ 5s");
    await popover.getByText("Clear all filters").click();
    await expect(rows).toHaveCount(4);
  });

  test("grouping by a column gathers traces under its values, fetched when expanded", async ({
    mount,
    page,
  }) => {
    const { component, rows } = await mountList(mount, page);

    await component.getByTitle("Group by").click();
    await page.getByRole("menuitemradio", { name: "Model" }).click();

    const groups = component.locator(".trace-table-row-group");
    await expect(names(groups)).toHaveText(["gpt-5", "No model", "claude"]);
    await expect(groups.locator(".trace-list-group-count")).toHaveText([
      "2",
      "1",
      "1",
    ]);
    await expect(groups.first()).toHaveAttribute("title", "gpt-5 — 2 traces");

    await groups.first().click();
    const children = component.locator(".trace-table-row-child");
    await expect(names(children)).toHaveText([
      "summarize ticket",
      "summarize email",
    ]);
    await children.first().click();
    await expect(children.first()).toHaveClass(/-selected/);

    // A search narrows the groups, and what's under the one left open.
    await component.getByRole("button", { name: "Toggle search" }).click();
    await component.getByRole("searchbox").fill("email");
    await expect(names(groups)).toHaveText(["gpt-5"]);
    await expect(names(children)).toHaveText(["summarize email"]);
    await expect(rows).toHaveCount(2);
  });

  test("grouping by cost uses buckets, and by date a chosen resolution", async ({
    mount,
    page,
  }) => {
    const { component } = await mountList(mount, page);
    const groups = component.locator(".trace-table-row-group");
    const groupBy = component.getByTitle("Group by");

    await groupBy.click();
    await page.getByRole("menuitemradio", { name: "Cost" }).click();
    await expect(names(groups)).toHaveText([
      "$0.01 – $0.1",
      "$0.1 – $1",
      "No cost",
    ]);

    await groupBy.click();
    await page.getByRole("menuitemradio", { name: "Date" }).click();
    await expect(groups).toHaveCount(4); // A day each.
    await page.getByRole("button", { name: "Month" }).click();
    const month = (ms: number) =>
      new Date(ms).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    await expect(names(groups)).toHaveText([
      month(NOON),
      month(NOON - 40 * DAY),
    ]);
    await expect(groups.locator(".trace-list-group-count")).toHaveText([
      "3",
      "1",
    ]);

    // Back to no grouping at all.
    await page.getByRole("menuitemradio", { name: "None" }).click();
    await expect(groups).toHaveCount(0);
    await expect(component.locator(".trace-table-row")).toHaveCount(4);
  });
});
