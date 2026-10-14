// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import type { ReactElement } from "react";
import type {
  Dataset,
  DatasetRow,
  DatasetRowUpdate,
  ExecutionInput,
  TraceWithSpans,
} from "../../../shared/types";
import { DatasetViewHarness } from "./DatasetViewHarness";
import { TraceViewHarness } from "./TraceViewHarness";
import { buildViews, routeViews } from "./view-routes";

/**
 * View tabs as TraceView and DatasetView host them (`specs/dataset-views.md`
 * §C, §D): plain-DOM views, so the test project needs no React.
 */
const VIEWS = {
  ".evalution/views/traces/spans.ts": `
    import { traceView } from "evalution/views";
    const render = (el, p) => { el.textContent = "spans: " + p.trace.spans.map(s => s.name).join(","); };
    export default traceView({
      label: "Span names",
      applies: t => t.spans.some(s => s.kind === "TOOL"),
      mount(el, p) { render(el, p); return { update: q => render(el, q) }; },
    });
  `,
  ".evalution/views/datasets/rows.ts": `
    import { datasetView } from "evalution/views";
    function render(el, p) {
      el.innerHTML = "";
      const shown = document.createElement("p");
      shown.id = "shown";
      shown.textContent = p.selected
        ? "row " + p.selected.row.id + " (" + (p.selected.label ?? "") + ")"
        : "none";
      // What the row was before the draft: only there while there is one.
      const stored = document.createElement("p");
      stored.id = "stored";
      stored.textContent = p.selected && p.selected.stored
        ? "stored " + p.selected.stored.cells["0"].value.value
        : "no draft";
      const rename = document.createElement("button");
      rename.textContent = "rename";
      rename.onclick = () => p.proposeUpdate({
        rowId: p.selected.row.id,
        cells: { "0": { kind: "value", value: { kind: "primitive", value: "renamed" } } },
      });
      const dangle = document.createElement("button");
      dangle.textContent = "dangle";
      dangle.onclick = () => p.proposeUpdate({
        rowId: p.selected.row.id,
        cells: { "1": { kind: "instance", name: "nowhere" } },
      });
      const next = document.createElement("button");
      next.textContent = "next";
      next.onclick = () => p.selectRow(p.selected.index + 1);
      const show = document.createElement("button");
      show.textContent = "show task";
      show.onclick = () => p.showInstance("task");
      el.append(shown, stored, rename, dangle, next, show);
    }
    export default datasetView({
      label: "Rows view",
      applies: ({ overview }) => overview.rowCount > 0,
      mount(el, p) { render(el, p); return { update: q => render(el, q) }; },
    });
  `,
};

let built: Awaited<ReturnType<typeof buildViews>>;
test.beforeAll(async () => {
  built = await buildViews(VIEWS);
});

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
});

const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

const DATASET: Dataset = {
  id: "names",
  name: "Names",
  fields: [
    {
      id: "0",
      def: {
        name: "name",
        type: { kind: "primitive", syntax: "string", base: "string" },
        optional: false,
      },
    },
  ],
  rowLabel: { root: { field: "0" }, keys: [] },
  prompt: { id: "src/names.ts#greet", providerId: "files" },
  createdAt: 1,
  updatedAt: 1,
};
const ROWS: DatasetRow[] = ["alpha", "beta", "gamma"].map((name, i) => ({
  id: `r${i + 1}`,
  cells: { "0": text(name) },
  // Only the first row declares an instance.
  ...(i === 0 && { resources: { task: { uri: "tasks.ts#seededTask" } } }),
  createdAt: i,
}));

/** Serves the dataset; returns every update PATCHed to its rows. */
async function mockDataset(page: Page) {
  const updates: DatasetRowUpdate[][] = [];
  const base = "**/api/datasets/local/names";
  await page.route(base, route =>
    route.fulfill({
      json: {
        dataset: DATASET,
        rowCount: ROWS.length,
        fields: {},
        instances: {},
      },
    }),
  );
  await page.route(`${base}/rows?*`, route => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return route.fulfill({ json: ROWS.slice(offset, offset + limit) });
  });
  await page.route(`${base}/rows`, route => {
    updates.push(route.request().postDataJSON().updates);
    return route.fulfill({ status: 204, body: "" });
  });
  return updates;
}

const shown = (page: Page) =>
  page.frameLocator('iframe[title="Rows view"]').locator("#shown");
const storedLine = (page: Page) =>
  page.frameLocator('iframe[title="Rows view"]').locator("#stored");
const inFrame = (page: Page, name: string) =>
  page.frameLocator('iframe[title="Rows view"]').getByRole("button", { name });
const rowList = (page: Page) => page.getByRole("listbox", { name: "Rows" });

/** The linked prompt's resources: what gives a row's instances cards in the pane. */
const TASK = {
  uri: "tasks.ts#seededTask",
  label: "Seeded task",
  scope: "run" as const,
};

async function openRowsView(
  page: Page,
  mount: (c: ReactElement) => Promise<unknown>,
) {
  await routeViews(page, built);
  const updates = await mockDataset(page);
  await mount(
    <DatasetViewHarness
      providerId="local"
      datasetId="names"
      promptName="greet"
      linkedPrompt={{
        functionParameters: DATASET.fields.map(f => f.def),
        inputSources: {
          resources: [TASK],
          functionSlots: {},
          executeSlots: {},
          resourceSlots: {},
        },
      }}
    />,
  );
  await page.getByRole("button", { name: "Rows view" }).click();
  return updates;
}

test("a dataset view tab shows the selected row beside a row list, and ↑/↓ move it", async ({
  mount,
  page,
}) => {
  await openRowsView(page, mount);
  // Nothing was selected in the grid, so the first row is.
  await expect(shown(page)).toHaveText("row r1 (alpha)");
  await expect(rowList(page).getByRole("option")).toHaveText([
    "1alpha",
    "2beta",
    "3gamma",
  ]);
  await rowList(page).getByRole("option", { name: "2 beta" }).click();
  await expect(shown(page)).toHaveText("row r2 (beta)");
  await rowList(page).press("ArrowDown");
  await expect(shown(page)).toHaveText("row r3 (gamma)");
  await rowList(page).press("ArrowUp");
  await expect(shown(page)).toHaveText("row r2 (beta)");
  // A view can select rows too.
  await inFrame(page, "next").click();
  await expect(shown(page)).toHaveText("row r3 (gamma)");
});

test("the selection survives switching to the grid and back; closing the pane keeps the row", async ({
  mount,
  page,
}) => {
  await openRowsView(page, mount);
  await rowList(page).getByRole("option", { name: "2 beta" }).click();
  await page.getByRole("button", { name: "Grid" }).click();
  // The grid selects the row, and its pane opens on it.
  await expect(page.locator(".trace-row-name")).toContainText("Row 2");
  await page.getByRole("button", { name: "Rows view" }).click();
  await expect(shown(page)).toHaveText("row r2 (beta)");
  // The pane came along; the tab bar's toggle hides it but keeps the row.
  // A view tab's pane has no close button of its own.
  const toggle = page.getByRole("button", { name: "Row details" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".trace-row-name")).toContainText("Row 2");
  await expect(page.getByRole("button", { name: "Close details" })).toHaveCount(
    0,
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".trace-row-name")).toHaveCount(0);
  await expect(shown(page)).toHaveText("row r2 (beta)");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".trace-row-name")).toContainText("Row 2");
});

test("a view can ask for an instance to be shown, opening a closed details pane", async ({
  mount,
  page,
}) => {
  await openRowsView(page, mount);
  await expect(page.locator(".trace-row-name")).toHaveCount(0);
  await inFrame(page, "show task").click();
  await expect(page.locator(".trace-row-name")).toContainText("Row 1");
  const card = page.locator("[data-instance-card='task']");
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/pg-row-highlight/);
  // Gone after a moment, and a repeat request flashes it again.
  await expect(card).not.toHaveClass(/pg-row-highlight/);
  await inFrame(page, "show task").click();
  await expect(card).toHaveClass(/pg-row-highlight/);
});

test("a view's proposal lands in a draft, which saves only on Save", async ({
  mount,
  page,
}) => {
  const updates = await openRowsView(page, mount);
  await inFrame(page, "rename").click();
  // The view gets the row back with its change applied.
  await expect(shown(page)).toHaveText("row r1 (renamed)");
  await expect(page.getByRole("status")).toContainText(
    "Unsaved changes to Row 1 from Rows view",
  );
  // Beside it, the row as stored: so the view can tell what's unsaved.
  await expect(storedLine(page)).toHaveText("stored alpha");
  expect(updates).toEqual([]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(storedLine(page)).toHaveText("no draft");
  await expect
    .poll(() => updates)
    .toEqual([[{ rowId: "r1", cells: { "0": text("renamed") } }]]);
});

test("Discard drops the draft, and a proposal that would dangle is refused", async ({
  mount,
  page,
}) => {
  const updates = await openRowsView(page, mount);
  await inFrame(page, "dangle").click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await inFrame(page, "rename").click();
  await expect(shown(page)).toHaveText("row r1 (renamed)");
  await expect(storedLine(page)).toHaveText("stored alpha");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(shown(page)).toHaveText("row r1 (alpha)");
  await expect(storedLine(page)).toHaveText("no draft");
  expect(updates).toEqual([]);
});

test("a save the server refuses brings the draft back", async ({
  mount,
  page,
}) => {
  await openRowsView(page, mount);
  // Registered last, so it answers before mockDataset's route.
  await page.route("**/api/datasets/local/names/rows", route =>
    route.fulfill({ status: 400, json: { error: "no" } }),
  );
  await inFrame(page, "rename").click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Unsaved changes to Row 1 from Rows view",
  );
  // Restored against the row as stored, so it can be saved again.
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await expect(shown(page)).toHaveText("row r1 (renamed)");
});

const TRACE: TraceWithSpans = {
  trace: { id: "t1", name: "run", startTime: 0, endTime: 10, status: "ok" },
  spans: [
    {
      id: "s1",
      traceId: "t1",
      name: "plan",
      kind: "AGENT",
      startTime: 0,
      endTime: 10,
    },
    {
      id: "s2",
      traceId: "t1",
      name: "create_task",
      kind: "TOOL",
      parentId: "s1",
      startTime: 1,
      endTime: 2,
    },
  ],
};

test("the trace view gets a tab for a view that applies, beside Conversation and Spans", async ({
  mount,
  page,
}) => {
  await routeViews(page, built);
  await page.route("**/api/traces/*/*/events", route =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"connected"}\n\n',
    }),
  );
  await page.route("**/api/traces/*/*/annotations", route =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/traces/*/*/check-results", route =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/traces/*/*", route =>
    route.fulfill({ json: TRACE }),
  );
  await mount(<TraceViewHarness />);
  await page.getByRole("button", { name: "Span names" }).click();
  await expect(
    page.frameLocator('iframe[title="Span names"]').locator("body"),
  ).toHaveText("spans: plan,create_task");
  // The tab is remembered for the next trace.
  expect(
    await page.evaluate(() => localStorage.getItem("evalution.traceTab")),
  ).toBe("view:.evalution/views/traces/spans.ts");
});
