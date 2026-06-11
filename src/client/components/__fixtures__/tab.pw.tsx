// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { Tab } from "../Tab";

const noop = () => {};

test("dirty tab has the same width as clean tab", async ({ mount }) => {
  const component = await mount(
    <div className="pane-tabs-scroll" style={{ display: "flex" }}>
      <Tab
        id="clean"
        name="my-prompt"
        active
        dirty={false}
        onClick={noop}
        onClose={noop}
        onDragStart={noop}
        onDragEnd={noop}
      />
      <Tab
        id="dirty"
        name="my-prompt"
        active
        dirty
        onClick={noop}
        onClose={noop}
        onDragStart={noop}
        onDragEnd={noop}
      />
    </div>,
  );

  const cleanWidth = await component
    .locator("#clean")
    .evaluate(el => el.getBoundingClientRect().width);
  const dirtyWidth = await component
    .locator("#dirty")
    .evaluate(el => el.getBoundingClientRect().width);

  expect(
    dirtyWidth,
    `dirty tab (${dirtyWidth}px) ≠ clean tab (${cleanWidth}px)`,
  ).toBe(cleanWidth);
});
