// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import type { EvalDefinition, EvalRun } from "../../../eval/eval-types";
import { EvalRunViewHarness } from "./EvalRunViewHarness";

const RUN: EvalRun = {
  id: "run_1",
  evalId: "e1",
  status: "done",
  definition: {
    id: "e1",
    name: "Triage",
    prompt: { id: "src/support.ts#triage", providerId: "files" },
    dataset: { providerId: "local", id: "tickets" },
    inputs: { functionInputs: {}, executeInputs: {} },
    checks: [],
    createdAt: 1,
    updatedAt: 1,
  } as EvalDefinition,
  arms: [{ id: "a0", label: "Working tree", spec: { kind: "head" } }],
  dirty: false,
  drifted: false,
  concurrency: 1,
  total: 0,
  startedAt: Date.UTC(2026, 8, 30, 9),
};

/**
 * Serves `run`, with no results and no other runs, and records the path of
 * every DELETE — answered with `deleteStatus`.
 */
async function mockRun(page: Page, run: EvalRun, deleteStatus = 204) {
  const deletes: string[] = [];
  await page.route(`**/api/eval-runs/local-evals/${run.id}`, route => {
    if (route.request().method() === "DELETE") {
      deletes.push(new URL(route.request().url()).pathname);
      return deleteStatus === 204
        ? route.fulfill({ status: 204 })
        : route.fulfill({ status: deleteStatus, json: { error: "disk full" } });
    }
    return route.fulfill({
      json: {
        run,
        results: { rows: [], checks: [] },
        running: run.status === "running",
      },
    });
  });
  await page.route(`**/api/evals/local-evals/${run.evalId}/runs`, route =>
    route.fulfill({ json: [] }),
  );
  return deletes;
}

test("the header's trash button, styled as the eval's, deletes the run", async ({
  mount,
  page,
}) => {
  const deletes = await mockRun(page, RUN);
  let deleted = 0;
  const component = await mount(
    <EvalRunViewHarness
      providerId="local-evals"
      runId="run_1"
      onDeleted={() => deleted++}
    />,
  );
  const del = component.getByRole("button", { name: "Delete run" });
  // The dashed button EvalView's header uses to delete the eval.
  await expect(del).toHaveClass(/trace-view-prompt-btn/);
  await expect(del).toHaveClass(/trace-view-delete-btn/);
  await expect(del).toHaveCSS("border-top-style", "dashed");

  page.once("dialog", d => d.dismiss());
  await del.click();
  expect(deletes).toEqual([]);

  page.once("dialog", async d => {
    expect(d.message()).toMatch(/^Delete the run from .* and its results\?$/);
    await d.accept();
  });
  await del.click();
  await expect.poll(() => deleted).toBe(1);
  expect(deletes).toEqual(["/api/eval-runs/local-evals/run_1"]);
});

test("deleting a run in flight says it'll be cancelled first", async ({
  mount,
  page,
}) => {
  await mockRun(page, { ...RUN, status: "running" });
  let deleted = 0;
  const component = await mount(
    <EvalRunViewHarness
      providerId="local-evals"
      runId="run_1"
      onDeleted={() => deleted++}
    />,
  );
  page.once("dialog", async d => {
    expect(d.message()).toMatch(/^Cancel and delete the run from /);
    await d.accept();
  });
  await component.getByRole("button", { name: "Delete run" }).click();
  await expect.poll(() => deleted).toBe(1);
});

test("a failed delete leaves the run open, with the error shown", async ({
  mount,
  page,
}) => {
  await mockRun(page, RUN, 500);
  let deleted = 0;
  const component = await mount(
    <EvalRunViewHarness
      providerId="local-evals"
      runId="run_1"
      onDeleted={() => deleted++}
    />,
  );
  page.once("dialog", d => d.accept());
  const del = component.getByRole("button", { name: "Delete run" });
  await del.click();
  await expect(component.locator(".pg-exec-error")).toContainText("disk full");
  await expect(del).toBeEnabled();
  expect(deleted).toBe(0);
});
