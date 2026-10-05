// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { PromptRefActionsHarness } from "./PromptRefActionsHarness";

for (const theme of ["light", "dark"] as const) {
  test(`Save button label contrasts with its background in ${theme} mode`, async ({
    mount,
    page,
  }) => {
    await mount(<PromptRefActionsHarness theme={theme} />);
    const save = page.getByRole("button", { name: "Save", exact: true });
    const style = () =>
      save.evaluate(el => {
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor };
      });

    // The primary button is opaque and inverted against the label, even on hover.
    const resting = await style();
    expect(resting.color).not.toBe(resting.background);
    expect(resting.background).not.toMatch(/rgba\(.*, 0\.\d+\)/);

    await save.hover();
    const hovered = await style();
    expect(hovered.color).not.toBe(hovered.background);
    expect(hovered.background).not.toMatch(/rgba\(.*, 0\.\d+\)/);
  });
}
