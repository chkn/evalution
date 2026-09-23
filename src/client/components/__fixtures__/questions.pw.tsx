// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import {
  EvaluationQuestionsHarness,
  MixedModeQuestionsHarness,
  QuestionsHarness,
} from "./QuestionsHarness";

test.beforeEach(async ({ page }) => {
  await page.route(/\/model-definition(\?|$)/, route =>
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

test("a new option in a choice(…) call's criteria starts as None", async ({
  mount,
}) => {
  const component = await mount(<QuestionsHarness />);
  const card = component.locator('[data-question-index="0"]');
  await card.locator('[data-proppy-editor="record-add"]').click();

  const options = card.locator('[data-proppy-editor="record"] .pg-entry');
  await expect(options).toHaveCount(2);
  // The existing description is text; the new option has none.
  await expect(options.nth(0).locator(".pg-entry-none")).toHaveCount(0);
  await expect(options.nth(1).locator(".pg-entry-none")).toHaveText("None");
  await expect(component.getByTestId("questions-value")).toContainText(
    '{"kind":"primitive","value":null}',
  );
});

test.describe("AI SDK evaluation questions (object literals)", () => {
  test("adds a question from the union's cases, a score with its two levels", async ({
    mount,
  }) => {
    const component = await mount(<EvaluationQuestionsHarness />);
    const add = component.getByLabel("Add question");
    await expect(add.locator("option")).toHaveText([
      "Choose…",
      "Choice",
      "Score",
      "Boolean",
    ]);

    await add.selectOption("score");
    await expect(component.getByTestId("question-ids")).toHaveText(
      '["spam","question_2"]',
    );

    // The criteria are a plain array in `ai`'s types, still edited as a
    // rubric: at least two numbered levels, and more on request.
    const levels = component.locator(
      '[data-question-index="1"] .pg-score-level',
    );
    await expect(levels).toHaveCount(2);
    await component
      .locator('[data-question-index="1"] .pg-add-level-btn')
      .click();
    await expect(levels).toHaveCount(3);
  });

  test("labels a boolean question's criteria as yes and no outcomes", async ({
    mount,
  }) => {
    const component = await mount(<EvaluationQuestionsHarness />);
    await expect(
      component.locator('[data-question-index="0"] .pg-noul-outcome-label'),
    ).toHaveText(["Yes means", "No means"]);
  });

  test("a new choice option starts as None, and None can be chosen again", async ({
    mount,
    page,
  }) => {
    const component = await mount(<EvaluationQuestionsHarness />);
    await component.getByLabel("Add question").selectOption("choice");
    const card = component.locator('[data-question-index="1"]');
    /** The new question's criteria, as the editor last saved them. */
    const criteria = async () => {
      const text = await component.getByTestId("questions-value").textContent();
      return JSON.parse(text!).properties.question_2.properties.criteria
        .properties;
    };

    await card.locator('[data-proppy-editor="record-add"]').click();
    // A description of `null`, not `""`: an option can go without one.
    await expect(card.locator(".pg-entry-none")).toHaveCount(1);
    await expect
      .poll(async () => Object.values(await criteria()))
      .toEqual([{ kind: "primitive", value: null }]);

    // Opening the editor and leaving it empty keeps the null.
    await card.locator(".pg-entry-none").click();
    const editor = card.locator('[data-proppy-editor="record"] .pg-entry-text');
    await expect(editor).toBeFocused();
    await component.getByLabel("Question id").first().click();
    await expect(card.locator(".pg-entry-none")).toHaveCount(1);

    // Typing writes a description…
    await card.locator(".pg-entry-none").click();
    await page.keyboard.type("Refunds");
    await expect
      .poll(async () => JSON.stringify(await criteria()))
      .toContain("Refunds");

    // …and None sets it back to null.
    await card.getByTitle("Set to null").last().click();
    await expect(card.locator(".pg-entry-none")).toHaveCount(1);
    await expect
      .poll(async () => Object.values(await criteria()))
      .toEqual([{ kind: "primitive", value: null }]);
  });
});
