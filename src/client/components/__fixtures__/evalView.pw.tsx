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
