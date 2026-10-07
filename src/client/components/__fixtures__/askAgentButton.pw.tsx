// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { OTHER_AGENT_URL } from "../../../shared/agent";
import { AskAgentButtonHarness } from "./AskAgentButtonHarness";

test("renders nothing for a host that lists no agents", async ({ mount }) => {
  const component = await mount(<AskAgentButtonHarness count={0} />);
  await expect(component.getByRole("button")).toHaveCount(0);
});

test("is a dropdown even with a single agent", async ({ mount, page }) => {
  const component = await mount(<AskAgentButtonHarness count={1} />);
  const trigger = component.getByRole("button", { name: "Ask AI" });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
});

test("lists every agent, greying out one that isn't installed", async ({
  mount,
  page,
}) => {
  const component = await mount(<AskAgentButtonHarness />);
  await component.getByRole("button", { name: "Ask AI" }).click();

  // The menu is portaled to the body, outside the mounted component.
  const menu = page.getByRole("menu");
  const claude = menu.getByRole("menuitem", { name: /Claude Code/ });
  await expect(claude).toBeDisabled();
  await expect(claude).toContainText("Not found");
  await expect(claude).toHaveAttribute("title", "claude not found in PATH");

  const codex = menu.getByRole("menuitem", { name: "Codex" });
  await expect(codex).toBeEnabled();
  await expect(codex).not.toContainText("Not found");

  await codex.click();
  await expect(component.getByTestId("asked")).toHaveText("codex");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("ends with a separator and an always-enabled Other link", async ({
  mount,
  page,
}) => {
  const component = await mount(<AskAgentButtonHarness />);
  await component.getByRole("button", { name: "Ask AI" }).click();

  const menu = page.getByRole("menu");
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(3);
  await expect(items.last()).toHaveText("Other");
  await expect(items.last()).toHaveAttribute("href", OTHER_AGENT_URL);
  await expect(items.last()).toHaveAttribute("target", "_blank");
  // The separator sits between the agents and Other.
  await expect(menu.locator("hr + [role='menuitem']")).toHaveText("Other");
});
