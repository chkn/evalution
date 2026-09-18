// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { InterpolationHarness } from "./InterpolationHarness";

test("a message holding a raw value renders read-only even though the SDK supports editing it", async ({
  mount,
  page,
}) => {
  await page.route("**/model-parameters", route => route.fulfill({ json: [] }));
  const component = await mount(
    <InterpolationHarness
      messageContent={{ kind: "raw", sourceText: "buildGreeting(name)" }}
    />,
  );

  // Only the system message gets an editor; the raw message is shown as text.
  await expect(component.locator(".token-editor")).toHaveCount(1);
  const readonly = component.locator(
    '[data-message-index="0"] [data-readonly="true"]',
  );
  await expect(readonly).toHaveText("buildGreeting(name)");
  await expect(readonly).not.toHaveAttribute("contenteditable", /.*/);
});
