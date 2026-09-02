// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { UnionMemberHarness } from "./UnionMemberHarness";

// Selects, in order: `description: string | null`,
// `width: 'auto' | 'none' | number`, `seed: string | number`.

test("lists every member of the union, constants and open-ended alike", async ({
  mount,
}) => {
  const component = await mount(<UnionMemberHarness />);

  await expect(component.locator("select").nth(0).locator("option")).toHaveText(
    ["string", "null"],
  );
  await expect(component.locator("select").nth(1).locator("option")).toHaveText(
    ["'auto'", "'none'", "number"],
  );
  await expect(component.locator("select").nth(2).locator("option")).toHaveText(
    ["string", "number"],
  );
});

test("opens on the first open-ended member's own editor, not a JSON textarea", async ({
  mount,
}) => {
  const component = await mount(<UnionMemberHarness />);

  await expect(
    component.locator("[data-proppy-editor='json-fallback']"),
  ).toHaveCount(0);
  // One field per parameter: description's string, width's number, seed's string.
  await expect(component.locator("input, textarea")).toHaveCount(3);
  await expect(component.locator("select").nth(1)).toHaveValue("2");
  await expect(component.locator("input, textarea").nth(1)).toHaveAttribute(
    "type",
    "number",
  );
});

test("switching between open-ended members swaps in that member's editor", async ({
  mount,
}) => {
  const component = await mount(<UnionMemberHarness />);
  const seed = component.locator("input, textarea").nth(2);

  await expect(seed).not.toHaveAttribute("type", "number");
  await component.locator("select").nth(2).selectOption({ label: "number" });
  await expect(component.locator("input, textarea").nth(2)).toHaveAttribute(
    "type",
    "number",
  );
});

test("a chosen constant keeps its own type instead of being stringified", async ({
  mount,
}) => {
  const component = await mount(<UnionMemberHarness />);

  await component.locator("select").nth(0).selectOption({ label: "null" });
  await expect(component.getByTestId("values")).toHaveText(
    JSON.stringify({ description: { kind: "primitive", value: null } }),
  );

  await component.locator("select").nth(1).selectOption({ label: "'auto'" });
  await expect(component.getByTestId("values")).toHaveText(
    JSON.stringify({
      description: { kind: "primitive", value: null },
      width: { kind: "primitive", value: "auto" },
    }),
  );
});

test("a constant member needs no editor beneath the dropdown", async ({
  mount,
}) => {
  const component = await mount(<UnionMemberHarness />);
  const select = component.locator("select").nth(0);

  await select.selectOption({ label: "null" });
  await expect(component.locator("input, textarea")).toHaveCount(2);

  await select.selectOption({ label: "string" });
  await expect(component.locator("input, textarea")).toHaveCount(3);
});

test("switching members keeps what was entered under the previous one", async ({
  mount,
}) => {
  const component = await mount(<UnionMemberHarness />);
  const select = component.locator("select").nth(0);

  await component.locator("input, textarea").nth(0).fill("some notes");
  await select.selectOption({ label: "null" });
  await expect(component.getByTestId("values")).toHaveText(
    JSON.stringify({ description: { kind: "primitive", value: null } }),
  );

  await select.selectOption({ label: "string" });
  await expect(component.locator("input, textarea").nth(0)).toHaveValue(
    "some notes",
  );
  await expect(component.getByTestId("values")).toHaveText(
    JSON.stringify({ description: { kind: "primitive", value: "some notes" } }),
  );
});

test("keeps a separate draft per open-ended member", async ({ mount }) => {
  const component = await mount(<UnionMemberHarness />);
  const select = component.locator("select").nth(2);
  const seed = () => component.locator("input, textarea").nth(2);

  await seed().fill("abc");
  await select.selectOption({ label: "number" });
  await expect(seed()).toHaveValue("");

  await seed().fill("42");
  await select.selectOption({ label: "string" });
  await expect(seed()).toHaveValue("abc");

  await select.selectOption({ label: "number" });
  await expect(seed()).toHaveValue("42");
});

test("typing in a member's editor leaves the dropdown on that member", async ({
  mount,
}) => {
  const component = await mount(<UnionMemberHarness />);

  await component.locator("input, textarea").nth(0).fill("hello");
  await expect(component.locator("select").nth(0)).toHaveValue("0");
  await expect(component.getByTestId("values")).toHaveText(
    JSON.stringify({ description: { kind: "primitive", value: "hello" } }),
  );
});
