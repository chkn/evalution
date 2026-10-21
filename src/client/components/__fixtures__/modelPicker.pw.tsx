// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { PropDefinition } from "../../../shared/types";
import { FirstEditHarness } from "./FirstEditHarness";

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

test("a model typed into the first edit of a versioned prompt shows before the server answers", async ({
  mount,
  page,
}) => {
  // The server re-parses and type-checks the file, which takes seconds; the
  // update is held for longer than the assertion waits.
  let releaseUpdate!: () => void;
  const updateHeld = new Promise<void>(r => {
    releaseUpdate = r;
  });
  await page.route("**/api/**", async route => {
    const url = route.request().url();
    if (url.includes("/update")) {
      await updateHeld;
      await route.abort();
    } else if (url.includes("/model-definition")) {
      await route.fulfill({ json: GATEWAY_MODEL_DEFINITION });
    } else if (url.includes("/model-parameters")) {
      await route.fulfill({ json: [] });
    } else {
      await route.fulfill({ json: {} });
    }
  });

  const component = await mount(<FirstEditHarness />);
  await component.locator(".proppy-catalog-trigger").click();
  const input = component
    .page()
    .locator(".proppy-catalog-literal")
    .getByRole("textbox");
  await input.fill("vendor/custom-model");

  await expect(input).toHaveValue("vendor/custom-model", { timeout: 1000 });
  releaseUpdate();
});
