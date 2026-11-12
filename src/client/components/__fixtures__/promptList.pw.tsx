// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { NormalizedPrompt } from "../../../shared/types";
import { PromptListFetchHarness } from "./PromptListFetchHarness";

function chatPrompt(name: string): NormalizedPrompt {
  return {
    style: "chat",
    id: `greet.prompt.ts#${name}`,
    providerId: "fs",
    name,
    functionParameters: [],
    modelEditable: true,
    modelParameters: [],
    treePath: ["greet.prompt.ts"],
    systemEditable: true,
    messages: [],
    messagesEditable: true,
  };
}

test("keeps showing the current prompts while a refetch is in flight", async ({
  mount,
  page,
}) => {
  let releaseRefetch!: () => void;
  const refetchReleased = new Promise<void>(resolve => {
    releaseRefetch = resolve;
  });
  let requests = 0;
  await page.route("**/api/prompts", async route => {
    if (++requests === 1) {
      await route.fulfill({ json: [chatPrompt("hello")] });
      return;
    }
    await refetchReleased;
    await route.fulfill({ json: [chatPrompt("hello"), chatPrompt("bye")] });
  });

  const component = await mount(<PromptListFetchHarness />);
  await expect(component.getByText("hello")).toBeVisible();

  const refetchRequest = page.waitForRequest("**/api/prompts");
  await component.getByRole("button", { name: "Refetch" }).click();
  await refetchRequest;

  await expect(component.getByText("hello")).toBeVisible();
  await expect(component.getByText("Loading...")).toHaveCount(0);

  releaseRefetch();
  await expect(component.getByText("bye")).toBeVisible();
});

test("Esc in the search box clears the filter and hides the box", async ({
  mount,
  page,
}) => {
  await page.route("**/api/prompts", route =>
    route.fulfill({ json: [chatPrompt("hello"), chatPrompt("bye")] }),
  );
  const component = await mount(<PromptListFetchHarness />);
  await expect(component.getByText("hello")).toBeVisible();

  await component.getByRole("button", { name: "Toggle search" }).click();
  const filter = component.getByPlaceholder("Filter");
  await expect(filter).toBeFocused();
  await filter.fill("bye");
  await expect(component.getByText("hello")).toHaveCount(0);

  await filter.press("Escape");
  await expect(filter).toHaveCount(0);
  await expect(component.getByText("hello")).toBeVisible();
  await expect(component.getByText("bye")).toBeVisible();
});
