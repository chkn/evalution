// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import {
  PlaygroundExecutionHarness,
  PlaygroundExecutionRawParamHarness,
} from "./PlaygroundExecutionHarness";

async function mockExecute(page: Page) {
  await page.route("**/api/**", route =>
    route.fulfill({
      json: { traceId: "t1", tracerProviderId: "p1", rootSpanId: "s1" },
    }),
  );
}

test("running with an unresolvable raw parameter surfaces an actionable error", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionRawParamHarness sourceText="doSomething(x)" />,
  );

  await component.getByText("Run").click();

  const error = component.locator(".pg-exec-error");
  await expect(error).toContainText("config");
  await expect(error).toContainText("doSomething(x)");
});

test("a branded string parameter (e.g. a template-literal ID type) edits as plain text, not JSON", async ({
  mount,
  page,
}) => {
  await mockExecute(page);

  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "taskId",
          type: { kind: "primitive", syntax: "TaskId", base: "string" },
          optional: false,
        },
      ]}
    />,
  );

  await component.locator("textarea, input").first().fill("tsk_abc123");
  await component.getByText("Run").click();

  // Were this still routed to the JSON fallback editor, the typed text would
  // have been wrapped as an unmaterializable `raw` value and Run would surface
  // an error instead of executing cleanly.
  await expect(component.locator(".pg-exec-error")).toHaveCount(0);
});

test("a string parameter accepts newlines", async ({ mount, page }) => {
  await mockExecute(page);

  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "notes",
          type: { kind: "primitive", syntax: "string" },
          optional: false,
        },
      ]}
    />,
  );

  const field = component.locator("textarea, input").first();
  await field.click();
  await field.pressSequentially("line one");
  await field.press("Enter");
  await field.pressSequentially("line two");

  await expect(field).toHaveValue("line one\nline two");
});
