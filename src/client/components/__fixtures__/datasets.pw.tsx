// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import type {
  DatasetSummary,
  ExecutionInput,
  PropDefinition,
} from "../../../shared/types";
import type { PanelFillSource } from "../named-inputs";
import { DatasetViewHarness } from "./DatasetViewHarness";
import { PlaygroundExecutionHarness } from "./PlaygroundExecutionHarness";

const TICKET: PropDefinition = {
  name: "ticket",
  type: { kind: "primitive", syntax: "string" },
  optional: false,
};

const NOTE: PropDefinition = {
  name: "note",
  type: { kind: "primitive", syntax: "string" },
  optional: true,
};

const TRACE_SOURCE: PanelFillSource = {
  type: "trace",
  description: "trace 3f2a1b2c…",
  providerId: "local",
  traceId: "3f2a1b2c9d",
};

const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

/** Seeds the panel's persisted inputs for the harness prompt (id `test`). */
async function seedPanel(
  page: Page,
  functionInputs: Record<string, ExecutionInput>,
) {
  await page.evaluate(
    stored => localStorage.setItem("pg-exec-params:test", stored),
    JSON.stringify({ functionInputs }),
  );
}

async function storedPanel(page: Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("pg-exec-params:test") ?? "null"),
  );
}

/** Serves the dataset list and provider list the add menu fetches on open. */
async function mockDatasetList(page: Page, datasets: DatasetSummary[]) {
  await page.route("**/api/datasets", route =>
    route.fulfill({ json: datasets }),
  );
  await page.route("**/api/dataset-providers", route =>
    route.fulfill({ json: [{ id: "local" }] }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
});

test("the execute header offers Add to dataset, listing a zero-match dataset as disabled", async ({
  mount,
  page,
}) => {
  await mockDatasetList(page, [
    {
      providerId: "local",
      id: "numbers",
      name: "Numbers",
      rowCount: 3,
      fields: [
        {
          id: "0",
          def: { ...TICKET, type: { kind: "primitive", syntax: "number" } },
        },
      ],
      updatedAt: 1,
    },
    {
      providerId: "local",
      id: "tickets",
      name: "Tickets",
      rowCount: 1,
      fields: [{ id: "0", def: TICKET }],
      updatedAt: 2,
    },
  ]);
  await seedPanel(page, { ticket: text("My order never arrived") });

  const component = await mount(
    <PlaygroundExecutionHarness functionParameters={[TICKET]} />,
  );
  await component.getByRole("button", { name: "Add to dataset" }).click();

  // Same name, different type: offered, but disabled and saying why.
  const numbers = page.getByRole("menuitem", { name: /Numbers/ });
  await expect(numbers).toBeDisabled();
  await expect(numbers).toContainText("no matching fields");
  const tickets = page.getByRole("menuitem", { name: /Tickets/ });
  await expect(tickets).toBeEnabled();
  await expect(tickets).toContainText("1 of 1 field");
});

test("Add to dataset is disabled while every slot is empty", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness functionParameters={[TICKET]} />,
  );
  await expect(
    component.getByRole("button", { name: "Add to dataset" }),
  ).toBeDisabled();
});

test("New dataset… creates a dataset from the prompt's signature and adds the row", async ({
  mount,
  page,
}) => {
  await mockDatasetList(page, []);
  let created: any;
  let added: any;
  await page.route("**/api/datasets/local", async route => {
    created = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      json: {
        id: "support-tickets",
        name: created.name,
        fields: created.fields.map((f: any, i: number) => ({
          id: String(i),
          ...f,
        })),
        createdAt: 1,
        updatedAt: 1,
      },
    });
  });
  await page.route(
    "**/api/datasets/local/support-tickets/rows",
    async route => {
      added = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: [] });
    },
  );
  await seedPanel(page, { ticket: text("Refund please") });

  const component = await mount(
    <PlaygroundExecutionHarness functionParameters={[TICKET, NOTE]} />,
  );
  await component.getByRole("button", { name: "Add to dataset" }).click();
  await page.getByRole("menuitem", { name: "New dataset…" }).click();
  await page.getByLabel("New dataset name").fill("Support tickets");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(component.getByRole("status")).toContainText(
    "Added to Support tickets",
  );
  // The schema is the whole signature — the empty `note` included — linked
  // back to the prompt; the row holds only what was filled.
  expect(created.fields.map((f: any) => f.def.name)).toEqual([
    "ticket",
    "note",
  ]);
  expect(created.prompt).toEqual({ id: "test", providerId: "test" });
  expect(added.rows).toEqual([
    {
      cells: { "0": text("Refund please") },
      source: { kind: "playground", promptId: "test", providerId: "test" },
    },
  ]);
});

test("a fill overwrites matched slots, keeps the rest, says so, and persists", async ({
  mount,
  page,
}) => {
  await seedPanel(page, {
    ticket: text("old ticket"),
    note: text("my own note"),
  });

  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[TICKET, NOTE]}
      fill={{
        functionInputs: { ticket: text("from the trace") },
        executeInputs: {},
        from: TRACE_SOURCE,
        skipped: [{ name: "legacyFlag", reason: "no-match" }],
        nonce: 424242,
      }}
    />,
  );

  const notice = component.locator(".pg-exec-fill-notice");
  await expect(notice).toContainText("Filled from trace");
  await expect(notice).toContainText("Not filled: note");
  await expect(notice).toContainText("legacyFlag has no matching parameter");
  await expect(component.getByText("from the trace")).toBeVisible();

  const stored = await storedPanel(page);
  expect(stored.functionInputs).toEqual({
    ticket: text("from the trace"),
    note: text("my own note"),
  });
});

test("the fill notice's source is a link when it can be opened, with the description as a tooltip", async ({
  mount,
}) => {
  const opened: unknown[] = [];
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[TICKET, NOTE]}
      fill={{
        functionInputs: { ticket: text("from the trace") },
        executeInputs: {},
        from: TRACE_SOURCE,
        skipped: [],
        nonce: 1,
      }}
      onOpenFillSource={from => opened.push(from)}
    />,
  );

  const link = component.getByRole("button", { name: "trace ↗" });
  await expect(link).toHaveAttribute("title", "trace 3f2a1b2c…");
  await link.click();
  // What the app needs to reopen the trace even if its tab has since closed.
  await expect.poll(() => opened).toEqual([TRACE_SOURCE]);
});

test("the fill notice's source is plain text when it can't be opened", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[TICKET, NOTE]}
      fill={{
        functionInputs: { ticket: text("from the trace") },
        executeInputs: {},
        from: {
          type: "dataset",
          description: "Support tickets, row 4",
          providerId: "local",
          datasetId: "tickets",
          name: "Support tickets",
        },
        skipped: [],
        nonce: 2,
      }}
    />,
  );

  const notice = component.locator(".pg-exec-fill-notice");
  await expect(notice).toContainText("Filled from dataset");
  await expect(notice.locator(".pg-exec-fill-link")).toHaveCount(0);
});

test("DatasetView renders value, object, and resource cells", async ({
  mount,
  page,
}) => {
  await page.route("**/api/datasets/local/tickets", route =>
    route.fulfill({
      json: {
        dataset: {
          id: "tickets",
          name: "Support tickets",
          fields: [
            { id: "0", def: TICKET },
            {
              id: "1",
              def: {
                name: "ctx",
                type: { kind: "object", syntax: "{ db: Db; userId: string }" },
                optional: false,
              },
            },
            {
              id: "2",
              def: {
                name: "task",
                type: { kind: "opaque", syntax: "Task" },
                optional: false,
              },
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        rows: [
          {
            id: "r1",
            cells: {
              "0": text("My order never arrived"),
              "1": {
                kind: "object",
                properties: {
                  db: {
                    kind: "resource",
                    uri: ".evalution/playground/db.ts#db",
                  },
                  userId: text("u1"),
                },
              },
              "2": {
                kind: "resource",
                uri: ".evalution/playground/tasks.ts#seededTask",
                args: { title: text("Buy milk") },
              },
            },
            source: { kind: "trace", traceId: "t1", traceProviderId: "db" },
            createdAt: 1,
          },
          { id: "r2", cells: { "0": text("Refund please") }, createdAt: 2 },
        ],
      },
    }),
  );

  const component = await mount(
    <DatasetViewHarness providerId="local" datasetId="tickets" />,
  );

  await expect(component.getByText("Support tickets")).toBeVisible();
  await expect(component.getByText('"My order never arrived"')).toBeVisible();
  const chip = component.locator(".dataset-cell-chip");
  await expect(chip).toContainText("seededTask");
  await expect(chip).toContainText('title: "Buy milk"');
  await expect(component.getByText("trace ↗")).toBeVisible();

  const object = component.locator(".dataset-cell-object");
  await expect(object).toContainText("{…}");
  await object.hover();
  await expect(object.locator(".dataset-cell-expand")).toBeVisible();
  await expect(object.locator(".dataset-cell-expand")).toContainText(
    'userId: "u1"',
  );
  // A sparse row shows its missing cells as empty.
  await expect(component.locator(".dataset-cell-empty")).toHaveCount(2);
});

/** Serves one dataset, `tickets`, linked to a prompt, with a single row. */
async function mockLinkedDataset(page: Page) {
  await page.route("**/api/datasets/local/tickets", route =>
    route.fulfill({
      json: {
        dataset: {
          id: "tickets",
          name: "Support tickets",
          fields: [{ id: "0", def: TICKET }],
          prompt: { id: "src/support.ts#triage", providerId: "files" },
          createdAt: 1,
          updatedAt: Date.UTC(2026, 8, 21, 12),
        },
        rows: [{ id: "r1", cells: { "0": text("Hi") }, createdAt: 1 }],
      },
    }),
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
