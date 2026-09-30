// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator, Page, Route } from "@playwright/test";
import type {
  Dataset,
  DatasetRow,
  ExecutionInput,
  PropDefinition,
} from "../../../shared/types";
import { DatasetViewHarness } from "./DatasetViewHarness";

const TICKET: PropDefinition = {
  name: "ticket",
  type: { kind: "primitive", syntax: "string" },
  optional: false,
};

const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

/**
 * The grid's geometry, as `DatasetView` sets it — the row marker column is
 * Glide's width for up to 100 rows. The grid draws on a canvas, so clicks
 * land by position; what it drew is read back from its accessible mirror
 * (`role="grid"`), which holds the visible cells as text.
 */
const GRID = { marker: 32, group: 26, header: 32, row: 32 };

/**
 * A cell (`gridcell`) or header (`columnheader`) in the grid's accessible
 * mirror, by its text. The mirror is the canvas's fallback content, which
 * Playwright counts as hidden, so it's queried with `includeHidden`.
 */
function inGrid(
  scope: Locator,
  role: "gridcell" | "columnheader",
  name: string,
) {
  return scope
    .getByRole("grid", { includeHidden: true })
    .getByRole(role, { name, exact: true, includeHidden: true });
}

/** Clicks the grid canvas at `(x, y)` from its top-left corner. */
async function clickGrid(page: Page, x: number, y: number) {
  const box = await page.getByTestId("data-grid-canvas").boundingBox();
  if (!box) throw new Error("grid canvas not laid out");
  await page.mouse.click(box.x + x, box.y + y);
}

/** Clicks a data cell: `x` into the columns (past the marker), row `row`. */
function clickCell(page: Page, x: number, row: number, grouped: boolean) {
  const top = (grouped ? GRID.group : 0) + GRID.header;
  return clickGrid(page, GRID.marker + x, top + row * GRID.row + GRID.row / 2);
}

/**
 * The spacer Glide sizes to the width of all its columns — what the columns
 * add up to, which is otherwise only on the canvas.
 */
function gridWidth(scope: Locator) {
  return scope.locator(".dvn-stack > div").first();
}

/** Drags the column edge at `x` by `by` pixels. */
async function dragGrid(page: Page, x: number, y: number, by: number) {
  const box = await page.getByTestId("data-grid-canvas").boundingBox();
  if (!box) throw new Error("grid canvas not laid out");
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + by / 2, box.y + y);
  await page.mouse.move(box.x + x + by, box.y + y);
  await page.mouse.up();
}

/**
 * Serves `dataset` with `rows`: the overview on `GET …/:id`, and pages of
 * rows on `GET …/:id/rows`. Returns the `[offset, limit]` of every page
 * requested.
 */
async function mockDataset(
  page: Page,
  dataset: Dataset,
  rows: DatasetRow[],
  fields: Record<string, { keys: string[]; resource?: boolean }> = {},
) {
  const pages: [number, number][] = [];
  const base = `**/api/datasets/local/${dataset.id}`;
  await page.route(base, route =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { dataset, rowCount: rows.length, fields } })
      : route.fallback(),
  );
  await page.route(`${base}/rows?*`, route => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    pages.push([offset, limit]);
    return route.fulfill({ json: rows.slice(offset, offset + limit) });
  });
  return pages;
}

const SUPPORT: Dataset = {
  id: "tickets",
  name: "Support tickets",
  fields: [
    { id: "0", def: TICKET },
    {
      id: "1",
      def: {
        name: "task",
        type: { kind: "opaque", syntax: "Task" },
        optional: false,
      } as PropDefinition,
    },
  ],
  createdAt: 1,
  updatedAt: 1,
};

const SUPPORT_ROWS: DatasetRow[] = [
  {
    id: "r1",
    cells: {
      "0": text("My order never arrived"),
      "1": {
        kind: "resource",
        uri: ".evalution/playground/tasks.ts#seededTask",
        args: { title: text("Buy milk") },
      },
    },
    source: { kind: "trace", traceId: "t1", traceProviderId: "db" },
    createdAt: Date.UTC(2026, 8, 20, 9),
  },
  {
    id: "r2",
    cells: {
      "0": text("Refund please"),
      // Takes no `title`: that column is n/a for this row.
      "1": { kind: "resource", uri: ".evalution/playground/tasks.ts#blank" },
    },
    createdAt: 2,
  },
  { id: "r3", cells: {}, createdAt: 3 },
];

const SUPPORT_SHAPE = { "1": { keys: ["title"], resource: true } };

test("DatasetView draws value and resource cells, sparse cells as dashes", async ({
  mount,
  page,
}) => {
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );

  await expect(component.getByText("Support tickets")).toBeVisible();
  await expect(component.getByText("3 rows")).toBeVisible();
  // `ticket` is typed into in place, so its cell reads as its raw text.
  await expect(
    inGrid(component, "gridcell", "My order never arrived"),
  ).toBeAttached();
  await expect(
    inGrid(component, "gridcell", '◆ seededTask(title: "Buy milk")'),
  ).toBeAttached();
  await expect(inGrid(component, "gridcell", "trace ↗")).toBeAttached();
  // Row 3 has nothing in `task`, nor a source; row 2 has no source. (Its
  // empty `ticket` is an editor's, which reads as empty.)
  await expect(inGrid(component, "gridcell", "—")).toHaveCount(3);
});

test("the table ends after its last row, with nothing ruled below it", async ({
  mount,
  page,
}) => {
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  await expect(component.getByTestId("data-grid-canvas")).toBeVisible();

  // Glide rules its whole canvas, so what's below the last row is covered:
  // group header + header + 3 rows, one past the closing rule.
  const cover = component.locator(".dataset-grid-fill");
  const box = await cover.boundingBox();
  const grid = await component.locator(".dataset-grid").boundingBox();
  if (!box || !grid) throw new Error("grid not laid out");
  expect(box.y - grid.y).toBe(GRID.group + GRID.header + 3 * GRID.row + 1);
  // It reaches the bottom, so no ruled lines survive below it.
  expect(Math.round(box.y + box.height)).toBe(Math.round(grid.y + grid.height));

  // The cover must not swallow the scrollbars that live in that same
  // region: it takes no clicks, and the scroller paints above it. Glide
  // leaves the scroller `position: static`, where a z-index would be
  // ignored, so both halves are checked — headless Chromium hides
  // scrollbars (`--hide-scrollbars`), which rules out checking by pixels.
  const under = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.className ?? "",
    [box.x + box.width / 2, box.y + box.height - 4],
  );
  expect(under).not.toContain("dataset-grid-fill");

  const stacking = await page.evaluate(() => {
    const style = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no ${selector}`);
      const { position, zIndex, pointerEvents } = getComputedStyle(el);
      return { position, zIndex: Number(zIndex), pointerEvents };
    };
    return {
      cover: style(".dataset-grid-fill"),
      scroller: style(".dataset-grid .dvn-scroller"),
    };
  });
  expect(stacking.cover.pointerEvents).toBe("none");
  expect(stacking.scroller.position).not.toBe("static");
  expect(stacking.scroller.zIndex).toBeGreaterThan(stacking.cover.zIndex);
});

test("clicking a field's group header splits it into a column per argument", async ({
  mount,
  page,
}) => {
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  await expect(inGrid(component, "columnheader", "task")).toBeAttached();
  await expect(inGrid(component, "columnheader", "title")).toHaveCount(0);

  // `task` is the second column: 240px past `ticket`.
  await clickGrid(page, GRID.marker + 240 + 60, GRID.group / 2);

  await expect(inGrid(component, "columnheader", "title")).toBeAttached();
  // The head names the resource; the argument has its own column.
  await expect(inGrid(component, "gridcell", "◆ seededTask")).toBeAttached();
  await expect(inGrid(component, "gridcell", '"Buy milk"')).toBeAttached();
  await expect(inGrid(component, "gridcell", "n/a")).toHaveCount(1);

  // And back.
  await clickGrid(page, GRID.marker + 240 + 60, GRID.group / 2);
  await expect(inGrid(component, "columnheader", "title")).toHaveCount(0);
});

test("a field of typed-in objects expands into its properties, with no column of its own", async ({
  mount,
  page,
}) => {
  const info: ExecutionInput = {
    kind: "value",
    value: {
      kind: "object",
      properties: {
        title: { kind: "primitive", value: "Say hi" },
        description: { kind: "primitive", value: "Trivial task" },
      },
    },
  };
  await mockDataset(
    page,
    {
      ...SUPPORT,
      fields: [
        { id: "0", def: TICKET },
        {
          id: "1",
          def: {
            name: "taskInfo",
            type: { kind: "object", syntax: "{ title?: string }" },
            optional: false,
          } as PropDefinition,
        },
      ],
    },
    [{ id: "r1", cells: { "0": text("Hi"), "1": info }, createdAt: 1 }],
    { "1": { keys: ["title", "description"] } },
  );
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  // Collapsed, the object previews with its values.
  await expect(
    inGrid(
      component,
      "gridcell",
      '{ title: "Say hi", description: "Trivial task" }',
    ),
  ).toBeAttached();

  await clickGrid(page, GRID.marker + 240 + 60, GRID.group / 2);

  // Its properties became columns; the field itself no longer has one, since
  // it would only ever read `{…}`.
  await expect(inGrid(component, "columnheader", "title")).toBeAttached();
  await expect(inGrid(component, "columnheader", "description")).toBeAttached();
  await expect(inGrid(component, "columnheader", "taskInfo")).toHaveCount(0);
  await expect(inGrid(component, "gridcell", '"Say hi"')).toBeAttached();
});

test("expanding a field and resizing a column are remembered per dataset", async ({
  mount,
  page,
}) => {
  await page.evaluate(() => localStorage.clear());
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  const view = <DatasetViewHarness providerId="local" datasetId="tickets" />;
  const component = await mount(view);
  // Columns start at their defaults: marker + ticket + task + source.
  await expect(gridWidth(component)).toHaveAttribute("style", /width: 608px/);

  await clickGrid(page, GRID.marker + 240 + 60, GRID.group / 2);
  await expect(inGrid(component, "columnheader", "title")).toBeAttached();
  // Glide reads a mouse-up within 500ms of the last as a double-click, and
  // a double-click on a column's edge sizes it to fit its cells.
  await page.waitForTimeout(600);
  // Drag the right edge of `ticket` 120px wider.
  await dragGrid(page, GRID.marker + 240, GRID.group + GRID.header / 2, 120);

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("dataset-layout:local:tickets") ?? "null"),
  );
  expect(stored).toEqual({ expanded: ["1"], widths: { "0": 360 } });

  await component.unmount();
  const reopened = await mount(view);
  // Expanded, and `ticket` still 360 wide: 32 + 360 + 140 + 160 + 96.
  await expect(inGrid(reopened, "columnheader", "title")).toBeAttached();
  await expect(gridWidth(reopened)).toHaveAttribute("style", /width: 788px/);

  // Deleting the dataset takes its layout with it.
  await page.route("**/api/datasets/local/tickets", route =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 204 })
      : route.fallback(),
  );
  page.on("dialog", dialog => dialog.accept());
  await reopened.getByRole("button", { name: "Delete dataset" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("dataset-layout:local:tickets")),
    )
    .toBeNull();
});

test("selecting a row shows it in full in the details pane", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  const traces: string[] = [];
  const component = await mount(
    <DatasetViewHarness
      providerId="local"
      datasetId="tickets"
      onOpenTrace={(providerId, traceId) =>
        traces.push(`${providerId}/${traceId}`)
      }
    />,
  );
  await expect(component.getByTestId("data-grid-canvas")).toBeVisible();

  await clickCell(page, 40, 0, true);
  const pane = component.getByRole("region", { name: "Row details" });
  await expect(pane).toContainText("Row 1");
  await expect(pane).toContainText("r1");
  await expect(pane.getByText("My order never arrived")).toBeVisible();
  await expect(pane.getByText("seededTask")).toBeVisible();
  await expect(pane.getByText("title")).toBeVisible();
  await expect(pane.getByText("Buy milk")).toBeVisible();
  // Beside the grid when there's room.
  await expect(pane).toHaveClass(/trace-details-pane/);

  await pane.getByRole("button", { name: "trace ↗" }).click();
  expect(traces).toEqual(["db/t1"]);

  await pane.getByRole("button", { name: "Close details" }).click();
  await expect(pane).toHaveCount(0);
});

test("the details pane opens a row in the playground and deletes it", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  const linked = {
    ...SUPPORT,
    prompt: { id: "src/support.ts#triage", providerId: "files" },
  };
  await mockDataset(page, linked, SUPPORT_ROWS, SUPPORT_SHAPE);
  const deleted: string[] = [];
  await page.route("**/api/datasets/local/tickets/rows/*", route => {
    deleted.push(route.request().url().split("/").at(-1) ?? "");
    return route.fulfill({ status: 204 });
  });
  const opened: string[] = [];
  const component = await mount(
    <DatasetViewHarness
      providerId="local"
      datasetId="tickets"
      promptName="triage"
      onOpenInPlayground={(prompt, fill) =>
        opened.push(`${prompt.name}: ${fill.from.description}`)
      }
    />,
  );
  await expect(component.getByTestId("data-grid-canvas")).toBeVisible();

  await clickCell(page, 40, 1, true);
  const pane = component.getByRole("region", { name: "Row details" });
  await expect(pane).toContainText("Row 2");
  await pane.getByRole("button", { name: "Open row in playground" }).click();
  await expect.poll(() => opened).toEqual(["triage: Support tickets, row 2"]);

  await pane.getByRole("button", { name: "Delete row" }).click();
  await expect.poll(() => deleted).toEqual(["r2"]);
  await expect(pane).toHaveCount(0);
});

test("DatasetView pages rows in as they scroll into view", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  const rows: DatasetRow[] = Array.from({ length: 250 }, (_, i) => ({
    id: `r${i}`,
    cells: { "0": text(`ticket ${i + 1}`) },
    createdAt: i,
  }));
  const pages = await mockDataset(
    page,
    { ...SUPPORT, fields: [{ id: "0", def: TICKET }] },
    rows,
  );
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  await expect(inGrid(component, "gridcell", "ticket 1")).toBeAttached();
  // Only the first page: the rest haven't been scrolled to.
  expect(pages).toEqual([[0, 100]]);

  const box = await page.getByTestId("data-grid-canvas").boundingBox();
  if (!box) throw new Error("grid canvas not laid out");
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.wheel(0, 250 * GRID.row);
  await expect(inGrid(component, "gridcell", "ticket 250")).toBeAttached();
  expect(pages).toContainEqual([200, 100]);
});

/**
 * Types `value` into the selected cell's editor and saves it with Enter.
 * Enter opens the editor first, rather than typing straight onto the grid:
 * the first key typed there opens it, and the keys after it can land before
 * it has focus.
 */
async function typeIntoCell(page: Page, value: string) {
  await page.keyboard.press("Enter");
  const editor = page.locator(".dataset-grid-portal textarea");
  await editor.fill(value);
  await editor.press("Enter");
}

/**
 * Answers `PATCH …/rows` with `status`, returning the body of every request —
 * the batches of cell updates the view sent.
 */
async function mockUpdates(page: Page, status = 204) {
  const sent: unknown[] = [];
  await page.route("**/api/datasets/local/tickets/rows", route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    sent.push(route.request().postDataJSON());
    return status === 204
      ? route.fulfill({ status })
      : route.fulfill({ status, json: { error: "disk full" } });
  });
  return sent;
}

test("typing into a string cell saves it, showing it at once", async ({
  mount,
  page,
}) => {
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  const sent = await mockUpdates(page);
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  await expect(component.getByTestId("data-grid-canvas")).toBeVisible();

  // Row 3's `ticket` is empty.
  await clickCell(page, 40, 2, true);
  await typeIntoCell(page, "Late delivery");

  await expect
    .poll(() => sent)
    .toEqual([
      { updates: [{ rowId: "r3", cells: { "0": text("Late delivery") } }] },
    ]);
  await expect(inGrid(component, "gridcell", "Late delivery")).toBeAttached();

  // A resource cell is read-only in the grid: no editor opens there.
  await clickCell(page, 240 + 40, 0, true);
  await page.keyboard.press("Enter");
  await expect(page.locator(".dataset-grid-portal textarea")).toHaveCount(0);
  // Delete clears an editable cell to `null`, and skips a read-only one.
  await clickCell(page, 40, 1, true);
  await page.keyboard.press("Delete");
  await expect.poll(() => sent).toHaveLength(2);
  expect(sent[1]).toEqual({
    updates: [{ rowId: "r2", cells: { "0": null } }],
  });
});

test("a failed save reloads the row from the server and says why under the header", async ({
  mount,
  page,
}) => {
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  // Each save is held until both are sent, then both fail.
  const held: Route[] = [];
  await page.route("**/api/datasets/local/tickets/rows", route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    held.push(route);
  });
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  await expect(component.getByTestId("data-grid-canvas")).toBeVisible();

  await clickCell(page, 40, 1, true);
  await typeIntoCell(page, "Changed");
  await expect(inGrid(component, "gridcell", "Changed")).toBeAttached();
  await clickCell(page, 40, 1, true);
  await typeIntoCell(page, "Changed again");
  await expect(inGrid(component, "gridcell", "Changed again")).toBeAttached();

  await expect.poll(() => held.length).toBe(2);
  for (const route of held) {
    await route.fulfill({ status: 500, json: { error: "disk full" } });
  }
  await expect(component.locator(".dataset-view-action-error")).toContainText(
    "disk full",
  );
  await expect(inGrid(component, "gridcell", "Refund please")).toBeAttached();
  await expect(inGrid(component, "gridcell", "Changed")).toHaveCount(0);
  await expect(inGrid(component, "gridcell", "Changed again")).toHaveCount(0);
});

test("pasting a block fills the editable cells it covers, in one batch", async ({
  mount,
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const expected: PropDefinition = {
    name: "expected",
    type: { kind: "primitive", syntax: "number", base: "number" },
    optional: true,
  };
  await mockDataset(
    page,
    { ...SUPPORT, fields: [...SUPPORT.fields, { id: "2", def: expected }] },
    SUPPORT_ROWS,
  );
  const sent = await mockUpdates(page);
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  await expect(component.getByTestId("data-grid-canvas")).toBeVisible();

  // Three rows of `ticket`, `task`, `expected`, as a spreadsheet copies them.
  await page.evaluate(
    text => navigator.clipboard.writeText(text),
    [
      "Lost parcel\tignored\t1",
      "Refund\tignored\t2",
      "Wrong size\tignored\tnot a number",
    ].join("\n"),
  );
  await clickCell(page, 40, 0, false);
  await page.keyboard.press("ControlOrMeta+v");

  // `task` holds resources, so it's skipped; so is the value that isn't a
  // number. Everything else lands, grouped by row.
  await expect
    .poll(() => sent)
    .toEqual([
      {
        updates: [
          {
            rowId: "r1",
            cells: {
              "0": text("Lost parcel"),
              "2": { kind: "value", value: { kind: "primitive", value: 1 } },
            },
          },
          {
            rowId: "r2",
            cells: {
              "0": text("Refund"),
              "2": { kind: "value", value: { kind: "primitive", value: 2 } },
            },
          },
          { rowId: "r3", cells: { "0": text("Wrong size") } },
        ],
      },
    ]);
  await expect(inGrid(component, "gridcell", "Wrong size")).toBeAttached();
  await expect(inGrid(component, "gridcell", "2")).toBeAttached();
});

test("the details pane edits a value cell, committing on Enter, and clears any cell", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  const sent = await mockUpdates(page);
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  await expect(component.getByTestId("data-grid-canvas")).toBeVisible();

  await clickCell(page, 40, 1, true);
  const pane = component.getByRole("region", { name: "Row details" });
  const editor = pane.locator(".dataset-detail-editor textarea");
  await expect(editor).toHaveValue("Refund please");

  // Typing is a draft: nothing is sent until Enter.
  await editor.fill("Refund now");
  expect(sent).toEqual([]);
  await editor.press("Enter");
  await expect
    .poll(() => sent)
    .toEqual([
      { updates: [{ rowId: "r2", cells: { "0": text("Refund now") } }] },
    ]);
  await expect(inGrid(component, "gridcell", "Refund now")).toBeAttached();

  // The resource is read-only here too, but can be cleared.
  await expect(pane.getByText("blank")).toBeVisible();
  await pane.getByRole("button", { name: "Clear task" }).click();
  await expect.poll(() => sent).toHaveLength(2);
  expect(sent[1]).toEqual({
    updates: [{ rowId: "r2", cells: { "1": null } }],
  });
  await expect(pane.getByRole("button", { name: "Clear task" })).toHaveCount(0);
});

test("a details-pane edit is saved when the grid is clicked, on the same row or another", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await mockDataset(page, SUPPORT, SUPPORT_ROWS, SUPPORT_SHAPE);
  const sent = await mockUpdates(page);
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );
  await expect(component.getByTestId("data-grid-canvas")).toBeVisible();
  const pane = component.getByRole("region", { name: "Row details" });
  const editor = pane.locator(".dataset-detail-editor textarea");

  // Another cell of the same row: the pane stays, and the edit is saved.
  await clickCell(page, 40, 1, true);
  await editor.fill("Refund now");
  await clickCell(page, 300, 1, true);
  await expect
    .poll(() => sent)
    .toEqual([
      { updates: [{ rowId: "r2", cells: { "0": text("Refund now") } }] },
    ]);

  // Another row: the pane moves on, and the edit is saved to the row it
  // was made on.
  await clickCell(page, 40, 1, true);
  await editor.fill("Refund today");
  await clickCell(page, 40, 0, true);
  await expect(editor).toHaveValue("My order never arrived");
  await expect.poll(() => sent).toHaveLength(2);
  expect(sent[1]).toEqual({
    updates: [{ rowId: "r2", cells: { "0": text("Refund today") } }],
  });
});

/** Serves one dataset, `tickets`, linked to a prompt, with a single row. */
function mockLinkedDataset(page: Page) {
  return mockDataset(
    page,
    {
      id: "tickets",
      name: "Support tickets",
      fields: [{ id: "0", def: TICKET }],
      prompt: { id: "src/support.ts#triage", providerId: "files" },
      createdAt: 1,
      updatedAt: Date.UTC(2026, 8, 21, 12),
    },
    [{ id: "r1", cells: { "0": text("Hi") }, createdAt: 1 }],
  );
}

test("DatasetView's header shows when it was updated and links its prompt", async ({
  mount,
  page,
}) => {
  await mockLinkedDataset(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  const opened: string[] = [];
  const component = await mount(
    <DatasetViewHarness
      providerId="local"
      datasetId="tickets"
      promptName="triage"
      onOpenPrompt={prompt => {
        opened.push(prompt.name);
      }}
    />,
  );

  const meta = component.locator(".trace-view-meta");
  await expect(meta.locator(".trace-view-date-full")).toContainText("2026");
  const link = meta.locator(".trace-view-prompt-link");
  await expect(link).toHaveText("triage↗");
  await link.click();
  await expect.poll(() => opened).toEqual(["triage"]);
});

test("DatasetView renames the dataset on double-clicking its title", async ({
  mount,
  page,
}) => {
  await mockLinkedDataset(page);
  const renamed: string[] = [];
  await page.route("**/api/datasets/local/tickets", route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const { name } = route.request().postDataJSON();
    renamed.push(name);
    return route.fulfill({
      json: {
        id: "tickets",
        name,
        fields: [{ id: "0", def: TICKET }],
        createdAt: 1,
        updatedAt: 2,
      },
    });
  });
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );

  await expect(component.getByRole("button", { name: "Rename" })).toHaveCount(
    0,
  );
  await component.locator(".trace-view-name").dblclick();
  const input = component.getByLabel("Dataset name");
  await expect(input).toHaveValue("Support tickets");
  await expect(input).toBeFocused();

  // Escape backs out without renaming.
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(component.locator(".trace-view-name")).toHaveText(
    "Support tickets",
  );

  await component.locator(".trace-view-name").dblclick();
  await input.fill("Escalations");
  await input.press("Enter");
  await expect(component.locator(".trace-view-name")).toHaveText("Escalations");
  expect(renamed).toEqual(["Escalations"]);
});

test("DatasetView shows Delete inline when wide, in the ⋯ menu when narrow", async ({
  mount,
  page,
}) => {
  await mockLinkedDataset(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );

  const trigger = component.getByRole("button", { name: "More actions" });
  await expect(
    component.getByRole("button", { name: "Delete dataset" }),
  ).toBeVisible();
  await expect(trigger).toBeHidden();

  await page.setViewportSize({ width: 320, height: 700 });
  await expect(trigger).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Delete dataset" }),
  ).toBeHidden();
  await trigger.click();
  await expect(
    page.locator(".trace-header-menu .trace-header-menu-item", {
      hasText: "Delete dataset",
    }),
  ).toBeVisible();
});
