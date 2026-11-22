// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { ArrayBindingsHarness } from "./ArrayBindingsHarness";

test("each array element offers what fits an element", async ({ mount }) => {
  const component = await mount(<ArrayBindingsHarness />);
  await expect(component.locator(".pg-slot-chip")).toHaveText([
    /root/,
    /forge/,
  ]);
});

test("removing an element keeps every later element's source with it", async ({
  mount,
}) => {
  const component = await mount(<ArrayBindingsHarness />);
  await component.getByRole("button", { name: "Remove item 1" }).click();

  await expect(component.getByTestId("resources")).toHaveText(
    JSON.stringify({ "0": "pg.ts#root", "1": "pg.ts#forge" }),
  );
  await expect(component.locator(".pg-slot-chip")).toHaveText([
    /root/,
    /forge/,
  ]);
});

test("removing a bound element drops its source", async ({ mount }) => {
  const component = await mount(<ArrayBindingsHarness />);
  await component.getByRole("button", { name: "Remove item 2" }).click();

  await expect(component.getByTestId("resources")).toHaveText(
    JSON.stringify({ "1": "pg.ts#forge" }),
  );
  await expect(component.locator(".pg-slot-chip")).toHaveText([/forge/]);
});
