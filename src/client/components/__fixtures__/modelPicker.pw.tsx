// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import type { PropDefinition, PropValue } from "../../../shared/types";
import { EDIT_SAVE_DELAY_MS } from "../edit-save-delay";
import { FirstEditHarness } from "./FirstEditHarness";
import { ModelRowHarness } from "./ModelRowHarness";

/** A model slot with only a Gateway catalog: model strings typed free-form. */
const GATEWAY_MODEL_DEFINITION: PropDefinition = {
  name: "model",
  type: { kind: "primitive", syntax: "string", base: "string" },
  optional: false,
  catalogs: [
    {
      label: "Gateway",
      groups: [],
      literal: {
        name: "model",
        type: { kind: "primitive", syntax: "string", base: "string" },
        optional: false,
      },
    },
  ],
};

/** A saved update the test answers by hand, when it chooses to. */
interface HeldUpdate {
  model: string;
  respond: () => void;
}

/**
 * Mocks the server for {@link FirstEditHarness}: every update is held until the
 * test responds to it, and answers with the prompt as that update left it —
 * the first edit to head creating the unsaved-edits variation they land in.
 */
async function mockServer(page: Page) {
  const updates: HeldUpdate[] = [];
  let model = "openai/gpt-5.5";
  const prompt = () => ({
    id: "p1",
    providerId: "prov",
    name: "test",
    functionParameters: [],
    style: "chat",
    modelEditable: true,
    systemEditable: true,
    model: { kind: "primitive", value: model },
    messages: [],
    messagesEditable: true,
    modelParameters: [],
    ref: { promptId: "p1", variation: "w1" },
    variation: {
      id: "w1",
      promptId: "p1",
      wip: true,
      onHead: true,
      names: [],
      updates: {},
      createdAt: 0,
      updatedAt: 0,
    },
  });
  await page.route("**/api/**", async route => {
    const url = route.request().url();
    if (url.includes("/update")) {
      const sent = (
        route.request().postDataJSON().model as PropValue & {
          value: string;
        }
      ).value;
      await new Promise<void>(resolve => {
        updates.push({ model: sent, respond: resolve });
      });
      model = sent;
      await route.fulfill({ json: { prompt: prompt(), ref: prompt().ref } });
    } else if (url.includes("/model-definition")) {
      await route.fulfill({ json: GATEWAY_MODEL_DEFINITION });
    } else if (url.includes("/model-parameters")) {
      await route.fulfill({ json: [] });
    } else if (/\/api\/prompts\/prov\/p1(\?|$)/.test(url)) {
      await route.fulfill({ json: prompt() });
    } else {
      await route.fulfill({ json: {} });
    }
  });
  return updates;
}

const modelInput = (page: Page) =>
  page.locator(".proppy-catalog-literal").getByRole("textbox");

test("a model typed into the first edit of a versioned prompt shows before the server answers", async ({
  mount,
  page,
}) => {
  await mockServer(page);

  const component = await mount(<FirstEditHarness />);
  await component.locator(".proppy-catalog-trigger").click();
  await modelInput(page).fill("vendor/custom-model");

  await expect(modelInput(page)).toHaveValue("vendor/custom-model", {
    timeout: 1000,
  });
});

test("typing a model sends one save once typing settles", async ({
  mount,
  page,
}) => {
  const updates = await mockServer(page);

  const component = await mount(<FirstEditHarness />);
  await component.locator(".proppy-catalog-trigger").click();
  await modelInput(page).press("ControlOrMeta+a");
  await modelInput(page).pressSequentially("vendor/x", { delay: 20 });

  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0].model).toBe("vendor/x");
  // Nothing more follows what settled.
  await page.waitForTimeout(EDIT_SAVE_DELAY_MS * 2);
  expect(updates).toHaveLength(1);
});

test("a save's response landing after a newer one doesn't undo the newer model", async ({
  mount,
  page,
}) => {
  const updates = await mockServer(page);

  const component = await mount(<FirstEditHarness />);
  await component.locator(".proppy-catalog-trigger").click();
  await modelInput(page).fill("vendor/first");
  await expect.poll(() => updates.length).toBe(1);
  await modelInput(page).fill("vendor/second");
  await expect.poll(() => updates.length).toBe(2);

  // The newer save answers first, then the older one's response arrives.
  updates[1].respond();
  await page.waitForTimeout(100);
  updates[0].respond();
  await page.waitForTimeout(300);

  await expect(modelInput(page)).toHaveValue("vendor/second");
});

test("a picked preset, once saved, still follows the model changing elsewhere", async ({
  mount,
}) => {
  const component = await mount(<ModelRowHarness />);
  await component.locator(".proppy-catalog-trigger").click();
  await component.getByText("GPT-5.5", { exact: true }).click();
  const label = component.locator(".proppy-catalog-label");
  await expect(label).toHaveText("GPT-5.5");
  // Saved, and read back without the preset's binding candidates.
  await component.page().waitForTimeout(EDIT_SAVE_DELAY_MS + 100);

  await component.getByRole("button", { name: "Change elsewhere" }).click();

  await expect(label).toHaveText("vendor/other");
});
