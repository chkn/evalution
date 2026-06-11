// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { WelcomeWizardHarness } from "./WelcomeWizardHarness";

const SETUP_TASKS = [
  {
    id: "vercel-ai-sdk",
    label: "AI SDK",
    icon: "vercel",
    steps: [
      {
        kind: "install_package",
        id: "install-sdk",
        package: "@evalution/vercel-ai-sdk",
        completed: false,
      },
      {
        kind: "create_config",
        id: "create-config",
        path: ".evalution/config.ts",
        contents:
          "import { FilePromptProvider, VercelAISDK } from 'evalution';\n",
        completed: false,
      },
    ],
  },
];

// The manual-setup picker fetches its options from the server; stub them.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/setup-tasks", route =>
    route.fulfill({ json: SETUP_TASKS }),
  );
});

test("starts on the setup step with no next/create-prompt action", async ({
  mount,
}) => {
  const component = await mount(<WelcomeWizardHarness />);

  // The setup step shows both the agent and manual setup paths.
  await expect(
    component.getByRole("heading", { name: /Set up with a coding agent/ }),
  ).toBeVisible();
  await expect(
    component.getByRole("heading", { name: /Manual setup/ }),
  ).toBeVisible();

  // It advances on its own once a config loads, so it offers no manual progression.
  await expect(
    component.getByRole("button", { name: "Create New Prompt" }),
  ).toHaveCount(0);
  await expect(component.getByRole("button", { name: /Next/ })).toHaveCount(0);
});

test("manual setup lists the SDK steps and links other SDKs externally", async ({
  mount,
}) => {
  const component = await mount(<WelcomeWizardHarness />);

  // The step list shows both the install and create-config steps.
  await expect(component.getByText("@evalution/vercel-ai-sdk")).toBeVisible();
  await expect(component.getByText("config.ts")).toBeVisible();

  // The config snippet is hidden until the step is expanded.
  const snippet = component.locator(".copy-box-multiline pre");
  await expect(snippet).toHaveCount(0);
  await component.getByRole("button", { name: "Show" }).click();
  await expect(snippet).toContainText("VercelAISDK");

  await expect(
    component.getByRole("button", { name: /AI SDK/ }),
  ).toHaveAttribute("aria-pressed", "true");
  const other = component.getByRole("link", { name: "Other" });
  await expect(other).toHaveAttribute("target", "_blank");
});

test("an already-installed package shows as installed, not runnable", async ({
  mount,
  page,
}) => {
  await page.route("**/api/setup-tasks", route =>
    route.fulfill({
      json: [
        {
          ...SETUP_TASKS[0],
          steps: [
            { ...SETUP_TASKS[0].steps[0], completed: true },
            SETUP_TASKS[0].steps[1],
          ],
        },
      ],
    }),
  );
  const component = await mount(<WelcomeWizardHarness />);

  // The install step row reports completion instead of offering a Run link.
  const installRow = component.locator(".setup-step", {
    hasText: "@evalution/vercel-ai-sdk",
  });
  await expect(installRow.getByText("Installed")).toBeVisible();
  await expect(installRow.getByRole("button", { name: "Run" })).toHaveCount(0);
});

test("advances to the all-set step once a config is loaded", async ({
  mount,
}) => {
  const component = await mount(<WelcomeWizardHarness />);

  await expect(
    component.getByRole("heading", { name: /Manual setup/ }),
  ).toBeVisible();

  // Simulate the server picking up a freshly created config.
  await component.getByTestId("load-config").click();

  await expect(
    component.getByRole("heading", { name: /You're all set/ }),
  ).toBeVisible();
  await expect(
    component.getByRole("heading", { name: /Manual setup/ }),
  ).toHaveCount(0);
});

test("starts directly on the all-set step when already configured", async ({
  mount,
}) => {
  const component = await mount(<WelcomeWizardHarness initialConfigured />);

  await expect(
    component.getByRole("heading", { name: /You're all set/ }),
  ).toBeVisible();
  await expect(
    component.getByRole("heading", { name: /Manual setup/ }),
  ).toHaveCount(0);
});

test("all-set step links to the docs in a new tab", async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness initialConfigured />);

  const docs = component.getByRole("link", { name: /Read the docs/ });
  await expect(docs).toHaveAttribute(
    "href",
    "https://evalut.io/n/docs/getting-started",
  );
  await expect(docs).toHaveAttribute("target", "_blank");
});

test("Create New Prompt invokes the callback", async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness initialConfigured />);

  await expect(component.getByTestId("create-prompt-calls")).toHaveText("0");
  await component.getByRole("button", { name: "Create New Prompt" }).click();
  await expect(component.getByTestId("create-prompt-calls")).toHaveText("1");
});
