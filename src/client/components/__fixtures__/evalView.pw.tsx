// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator, Page } from "@playwright/test";
import type { EvalDefinition } from "../../../eval/eval-types";
import type {
  CheckInfo,
  Dataset,
  DatasetSummary,
  NormalizedPrompt,
  PropDefinition,
} from "../../../shared/types";
import { EvalViewHarness } from "./EvalViewHarness";

const string = (name: string, optional = false): PropDefinition => ({
  name,
  type: { kind: "primitive", syntax: "string" },
  optional,
});

const TRIAGE = {
  id: "src/support.ts#triage",
  providerId: "files",
  name: "triage",
  functionParameters: [string("ticket")],
  executeParameters: [],
} as unknown as NormalizedPrompt;

const TICKETS: Dataset = {
  id: "tickets",
  name: "Support tickets",
  fields: [{ id: "0", def: string("ticket") }],
  createdAt: 1,
  updatedAt: 1,
};

const TICKETS_SUMMARY = {
  providerId: "local",
  id: "tickets",
  name: "Support tickets",
} as unknown as DatasetSummary;

const CONTAINS: CheckInfo = {
  uri: "evalution/checks#contains",
  label: "Contains",
  group: "Built-in",
  parameters: [string("haystack"), string("needle")],
};

const EVAL: EvalDefinition = {
  id: "e1",
  name: "Triage",
  prompt: { id: TRIAGE.id, providerId: "files" },
  dataset: { providerId: "local", id: "tickets" },
  inputs: { functionInputs: {}, executeInputs: {} },
  checks: [],
  createdAt: 1,
  updatedAt: 1,
} as EvalDefinition;

/**
 * Serves `def` and the dataset, and records every PATCH of the eval — each
 * answered with the definition as patched, as the server does.
 */
async function mockEval(page: Page, def: EvalDefinition) {
  const patches: Record<string, unknown>[] = [];
  let current = def;
  await page.route(`**/api/evals/local-evals/${def.id}`, async route => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON();
      patches.push(patch);
      current = { ...current, ...patch };
    }
    return route.fulfill({ json: current });
  });
  await page.route(`**/api/evals/local-evals/${def.id}/runs`, route =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/datasets/local/tickets", route =>
    route.fulfill({ json: { dataset: TICKETS, rowCount: 0, fields: {} } }),
  );
  await page.route("**/api/checks", route =>
    route.fulfill({ json: [{ providerId: "files", checks: [CONTAINS] }] }),
  );
  return patches;
}

const mountEval = (
  mount: any,
  size: { width?: number; height?: number } = {},
) =>
  mount(
    <EvalViewHarness
      providerId="local-evals"
      evalId="e1"
      prompts={[TRIAGE]}
      datasets={[TICKETS_SUMMARY]}
      {...size}
    />,
  );

const rect = (loc: Locator) =>
  loc.evaluate(el => {
    const { top, bottom, left, right } = el.getBoundingClientRect();
    return { top, bottom, left, right };
  });

test("binds a same-named column to the prompt's input, marked as matched, and saves it", async ({
  mount,
  page,
}) => {
  const patches = await mockEval(page, EVAL);
  const component = await mountEval(mount);

  await expect(component.locator(".eval-matched")).toHaveCount(1);
  await expect(component.locator(".pg-slot-chip-pseudo")).toContainText(
    "ticket",
  );
  await expect
    .poll(() => patches.at(-1)?.inputs)
    .toEqual({
      functionInputs: { ticket: { kind: "dataset", field: "0" } },
      executeInputs: {},
    });
  await expect(component.getByRole("button", { name: /Run/ })).toBeEnabled();
});

test("lists an unbound check parameter as a problem, and won't run until it's bound", async ({
  mount,
  page,
}) => {
  await mockEval(page, {
    ...EVAL,
    checks: [{ id: "c1", uri: CONTAINS.uri, args: {} }],
  });
  const component = await mountEval(mount);

  const problems = component.getByRole("list", { name: "Problems" });
  await expect(problems).toContainText("'haystack' is required but unbound");
  await expect(problems).toContainText("'needle' is required but unbound");
  await expect(component.getByRole("button", { name: /Run/ })).toBeDisabled();
});

test("typing into a check parameter keeps focus, character by character", async ({
  mount,
  page,
}) => {
  // Every keystroke saves, and re-renders the editor; the field being typed
  // into must survive that, as the execute panel's do.
  await mockEval(page, {
    ...EVAL,
    checks: [{ id: "c1", uri: CONTAINS.uri, args: {} }],
  });
  const component = await mountEval(mount);

  const needle = component
    .locator(".pg-exec-param")
    .filter({ hasText: "needle" })
    .locator("textarea, input")
    .first();
  await needle.click();
  await needle.pressSequentially("refund");
  await expect(needle).toHaveValue("refund");
});

test("the inputs panel docks on the right when wide, and below when narrow, as the playground's does", async ({
  mount,
  page,
}) => {
  await mockEval(page, EVAL);
  const wide = await mountEval(mount, { width: 900 });
  await expect(wide.locator(".pg-exec-col")).toBeVisible();
  const editor = await rect(wide.locator(".pg-editor-col"));
  const exec = await rect(wide.locator(".pg-exec-col"));
  expect(exec.left).toBeGreaterThanOrEqual(editor.right - 1);
  expect(exec.top).toBeCloseTo(editor.top, 0);
  await wide.unmount();

  const narrow = await mountEval(mount, { width: 400 });
  await expect(narrow.locator(".pg-exec-col")).toBeVisible();
  const nEditor = await rect(narrow.locator(".pg-editor-col"));
  const nExec = await rect(narrow.locator(".pg-exec-col"));
  expect(nExec.top).toBeGreaterThanOrEqual(nEditor.bottom - 1);
  expect(nExec.left).toBeCloseTo(nEditor.left, 0);
});

test("the header links to the prompt and dataset, and the selectors live in the content", async ({
  mount,
  page,
}) => {
  await mockEval(page, EVAL);
  const component = await mountEval(mount);

  const header = component.locator(".pg-prompt-header");
  await expect(header.getByRole("button", { name: /triage/ })).toBeVisible();
  await expect(
    header.getByRole("button", { name: /Support tickets/ }),
  ).toBeVisible();
  await expect(header.locator("select")).toHaveCount(0);
  await expect(
    component.locator(".pg-editor-col").getByLabel("Prompt"),
  ).toBeVisible();
  await expect(
    component.locator(".pg-editor-col").getByLabel("Dataset"),
  ).toBeVisible();
});

test("Run sits at the bottom of the inputs panel", async ({ mount, page }) => {
  await mockEval(page, EVAL);
  const component = await mountEval(mount, { width: 900, height: 500 });
  const run = await rect(component.getByRole("button", { name: /Run/ }));
  const panel = await rect(component.locator(".pg-exec-col"));
  expect(run.bottom).toBeLessThanOrEqual(panel.bottom);
  expect(panel.bottom - run.bottom).toBeLessThan(40);
});

test("when narrow, Run is compact and problems span the full width", async ({
  mount,
  page,
}) => {
  await mockEval(page, {
    ...EVAL,
    checks: [{ id: "c1", uri: CONTAINS.uri, args: {} }],
  });
  const component = await mountEval(mount, { width: 520, height: 700 });
  const run = await rect(component.getByRole("button", { name: /Run/ }));
  const problems = await rect(
    component.getByRole("list", { name: "Problems" }),
  );
  const panel = await rect(component.locator(".pg-exec-col"));
  expect(run.right - run.left).toBeLessThan((panel.right - panel.left) / 3);
  expect(problems.right - problems.left).toBeGreaterThan(
    (panel.right - panel.left) * 0.8,
  );
});

test("the pickers' chevrons and the Delete button match the playground's and the other headers'", async ({
  mount,
  page,
}) => {
  await mockEval(page, EVAL);
  const component = await mountEval(mount);

  // The model picker's chevron is ▾; the pickers here draw the same.
  const chevrons = component.locator(".eval-select .proppy-catalog-chevron");
  await expect(chevrons).toHaveCount(2);
  for (const chevron of await chevrons.all()) {
    await expect(chevron).toHaveText("▾");
  }
  // Delete is the dashed button the dataset and trace headers use.
  const del = component.getByRole("button", { name: "Delete eval" });
  await expect(del).toHaveClass(/trace-view-prompt-btn/);
  await expect(del).toHaveClass(/trace-view-delete-btn/);
  await expect(del).toHaveCSS("border-top-style", "dashed");
});

test("checks are set apart by a rule, with their fields under one down the left", async ({
  mount,
  page,
}) => {
  await mockEval(page, {
    ...EVAL,
    checks: [
      { id: "c1", uri: CONTAINS.uri, args: {} },
      { id: "c2", uri: CONTAINS.uri, args: {} },
    ],
  });
  const component = await mountEval(mount, { width: 900, height: 800 });

  const checks = component.locator(".eval-check");
  await expect(checks).toHaveCount(2);
  // No box around a check; a rule between the two, none above the first.
  await expect(checks.first()).toHaveCSS("border-top-width", "0px");
  await expect(checks.first()).toHaveCSS("border-left-width", "0px");
  await expect(checks.last()).toHaveCSS("border-top-width", "1px");
  // The fields sit under a rule down the left.
  const fields = checks.first().locator(".eval-check-fields");
  await expect(fields).toHaveCSS("border-left-width", "2px");
});

test("what to run against is always showing, in the scrolling body above Run", async ({
  mount,
  page,
}) => {
  await mockEval(page, EVAL);
  const component = await mountEval(mount, { width: 900, height: 500 });

  const options = component.locator(".pg-exec-body .eval-run-options");
  await expect(options.getByLabel("Working tree")).toBeChecked();
  await expect(options.getByLabel("At once")).toHaveValue("4");
  // Set off from the inputs above by a rule, as the execute inputs are.
  const rule = component.locator(".pg-exec-body .pg-exec-section");
  expect(
    await rule.evaluate((el: Element) => getComputedStyle(el).borderTopWidth),
  ).toBe("1px");
  expect((await rect(options)).top).toBeGreaterThan((await rect(rule)).top);
  await expect(component.locator(".eval-run-summary")).toHaveCount(0);
  await expect(
    component.locator(".pg-exec-footer").getByRole("button", { name: /Run/ }),
  ).toBeVisible();
});

test("Unsaved edits joins the choices once the prompt has some", async ({
  mount,
  page,
}) => {
  await mockEval(page, EVAL);
  let variations: unknown[] = [];
  await page.route("**/api/prompts/**/variations", route =>
    route.fulfill({ json: variations }),
  );
  const component = await mountEval(mount);

  const options = component.locator(".eval-run-options");
  await expect(options.getByLabel("Working tree")).toBeChecked();
  await expect(options.getByLabel("Unsaved edits")).toHaveCount(0);

  // The prompt is edited elsewhere: it now reports a WIP at head.
  variations = [
    {
      id: "w1",
      promptId: TRIAGE.id,
      updates: {},
      wip: true,
      onHead: true,
      names: [],
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  await component.update(
    <EvalViewHarness
      providerId="local-evals"
      evalId="e1"
      prompts={[{ ...TRIAGE, dirty: true, wipId: "w1" }]}
      datasets={[TICKETS_SUMMARY]}
    />,
  );
  await expect(options.getByLabel("Unsaved edits")).toBeChecked();
});

test("the run warning wraps within the panel instead of widening it", async ({
  mount,
  page,
}) => {
  await mockEval(page, EVAL);
  await page.route("**/api/prompt-providers/files/head", route =>
    route.fulfill({ json: { versioned: true, clean: false } }),
  );
  const component = await mountEval(mount, { width: 520, height: 700 });

  const warning = component.locator(".eval-run-warning");
  await expect(warning).toContainText("uncommitted changes");
  const panel = await rect(component.locator(".pg-exec-col"));
  const box = await rect(warning);
  expect(box.right).toBeLessThanOrEqual(panel.right);
  // Wrapped onto several lines, not one long one.
  expect(box.bottom - box.top).toBeGreaterThan(2 * 11.5);
});

test("a check's fields live in its card, and a pass/fail built-in has no score threshold", async ({
  mount,
  page,
}) => {
  await mockEval(page, {
    ...EVAL,
    checks: [{ id: "c1", uri: CONTAINS.uri, args: {} }],
  });
  const component = await mountEval(mount);
  const card = component.locator(".eval-check");
  await expect(card.locator(".pg-exec-param")).toHaveCount(2);
  await expect(component.locator(".pg-exec-col .eval-check")).toHaveCount(0);
  await expect(card.getByLabel("Threshold")).toHaveCount(0);
});
