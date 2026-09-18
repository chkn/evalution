// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import {
  MixedModeQuestionsHarness,
  QuestionsHarness,
} from "./QuestionsHarness";

test.beforeEach(async ({ page }) => {
  await page.route("**/model-definition", route =>
    route.fulfill({ json: null }),
  );
});

test("renaming a question keeps focus in its id", async ({ mount, page }) => {
  const component = await mount(<QuestionsHarness />);
  const id = component.getByLabel("Question id").first();

  await id.click();
  await page.keyboard.press("End");
  await page.keyboard.type("_owner");
  await page.keyboard.press("Enter");

  await expect(component.getByTestId("question-ids")).toHaveText(
    '["team_owner"]',
  );
  await expect(id).toBeFocused();
  await expect(id).toHaveValue("team_owner");

  // Still typing into the same field after the rename lands.
  await page.keyboard.type("s");
  await expect(id).toHaveValue("team_owners");
});

test("completes ${…} in a choice description nested three levels deep", async ({
  mount,
  page,
}) => {
  const component = await mount(<QuestionsHarness />);
  // questions › team › criteria › billing
  const description = component
    .locator('[data-question-index="0"] [contenteditable="true"]')
    .last();
  await expect(description).toHaveText("Payments");

  await description.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" for ${tic");

  const items = page.locator(".te-suggest-item");
  await expect(items.first()).toHaveText(/ticket/);
  await page.keyboard.press("Tab");
  await page.keyboard.type(".");
  await expect(items.first()).toHaveText(/subject/);
  await page.keyboard.press("Enter");

  await expect(description.locator(".te-token")).toHaveText(
    "${ticket.subject}",
  );
});

test("adds a question from a factory under a fresh id", async ({ mount }) => {
  const component = await mount(<QuestionsHarness />);
  await component.getByLabel("Add question").selectOption("noul");
  await expect(component.getByTestId("question-ids")).toHaveText(
    '["team","question_2"]',
  );
});

test("switching an entry to JSON writes a structured value, not an empty string", async ({
  mount,
}) => {
  const component = await mount(<QuestionsHarness />);
  const stateCard = component.locator(".pg-state-card");

  // Text mode to begin with, so the button offers the other mode.
  const toggle = stateCard.locator(".pg-entry-toggle");
  await expect(toggle).toHaveText("JSON");
  await toggle.click();

  // The editor now offers the structured mode, and the value it wrote matches
  // it — writing `""` here would put a primitive under the record editor.
  await expect(toggle).toHaveText("Text");
  await expect(component.getByTestId("state-value")).toHaveText(
    '{"kind":"object","properties":{}}',
  );
});

test("deleting a question leaves its neighbour's entry mode alone", async ({
  mount,
}) => {
  const component = await mount(<MixedModeQuestionsHarness />);
  const cards = component.locator(".pg-question-card");
  await expect(cards).toHaveCount(2);

  // The first question's instructions are structured, the second's are text.
  await expect(cards.nth(0).locator(".pg-entry-toggle").first()).toHaveText(
    "Text",
  );
  await expect(cards.nth(1).locator(".pg-entry-toggle").first()).toHaveText(
    "JSON",
  );

  await cards.nth(0).getByTitle("Delete question").click();

  await expect(component.getByTestId("question-ids")).toHaveText('["plain"]');
  // Cards are keyed by position, so the survivor reuses the deleted card's
  // component instance; its mode must follow its own value.
  await expect(cards.nth(0).locator(".pg-entry-toggle").first()).toHaveText(
    "JSON",
  );
  await expect(cards.nth(0)).toContainText("Plain one");
});
