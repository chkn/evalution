// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import { WelcomeWizardHarness } from "./WelcomeWizardHarness";

const AGENT_TASKS = [
  {
    id: "claude-code",
    label: "Claude Code",
    icon: "Anthropic",
    steps: [
      {
        kind: "run_command",
        id: "launch",
        command: 'claude "Fetch https://evalut.io/n/docs/setup.md"',
        label: "Claude Code",
        // Stubbed as unavailable so the disabled-launcher behaviour is testable.
        disabledReason: "claude not found in PATH",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    icon: "OpenAI",
    steps: [
      {
        kind: "run_command",
        id: "launch",
        command: 'codex "Fetch https://evalut.io/n/docs/setup.md"',
        label: "Codex",
      },
    ],
  },
];

const SDK_TASKS = [
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

// The setup step fetches its agent + SDK options from the server; stub them.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/setup-tasks", route =>
    route.fulfill({ json: { agent: AGENT_TASKS, sdk: SDK_TASKS } }),
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

test("a coding-agent button opens a terminal queued with its command", async ({
  mount,
}) => {
  const component = await mount(<WelcomeWizardHarness />);

  const agents = component.getByRole("group", { name: "Coding agent" });
  await expect(
    agents.getByRole("button", { name: "Claude Code" }),
  ).toBeVisible();
  await expect(agents.getByRole("button", { name: "Codex" })).toBeVisible();

  await expect(component.getByTestId("last-terminal")).toHaveText("");
  await agents.getByRole("button", { name: "Codex" }).click();

  // taskId | stepId | command | label — see WelcomeWizardHarness. The command
  // is the run_command step resolved from the fetched agent task.
  await expect(component.getByTestId("last-terminal")).toHaveText(
    'codex|launch|codex "Fetch https://evalut.io/n/docs/setup.md"|Codex',
  );
});

test("a coding agent whose CLI is missing is disabled with the reason on hover", async ({
  mount,
}) => {
  const component = await mount(<WelcomeWizardHarness />);

  const agents = component.getByRole("group", { name: "Coding agent" });
  // Claude Code is stubbed as unavailable.
  await expect(
    agents.getByRole("button", { name: "Claude Code" }),
  ).toBeDisabled();
  await expect(
    component.locator(".setup-agent-option-wrap", { hasText: "Claude Code" }),
  ).toHaveAttribute("title", "claude not found in PATH");

  // Codex is available, so it stays enabled.
  await expect(agents.getByRole("button", { name: "Codex" })).toBeEnabled();
});

test("the coding-agent Other button links to the agent issue template", async ({
  mount,
}) => {
  const component = await mount(<WelcomeWizardHarness />);

  const other = component
    .getByRole("group", { name: "Coding agent" })
    .getByRole("link", { name: "Other" });
  await expect(other).toHaveAttribute(
    "href",
    "https://github.com/chkn/evalution/issues/new?template=agent-request.yml",
  );
  await expect(other).toHaveAttribute("target", "_blank");
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
  const other = component
    .getByRole("group", { name: "AI SDK" })
    .getByRole("link", { name: "Other" });
  await expect(other).toHaveAttribute(
    "href",
    "https://github.com/chkn/evalution/issues/new?template=sdk-request.yml",
  );
  await expect(other).toHaveAttribute("target", "_blank");
});

test("a manual step with a disabledReason is disabled with the reason on hover", async ({
  mount,
  page,
}) => {
  await page.route("**/api/setup-tasks", route =>
    route.fulfill({
      json: {
        agent: AGENT_TASKS,
        sdk: [
          {
            id: "vercel-ai-sdk",
            label: "AI SDK",
            icon: "vercel",
            steps: [
              {
                kind: "run_command",
                id: "build",
                command: "foo build",
                label: "Build",
                disabledReason: "foo not found in PATH",
              },
            ],
          },
        ],
      },
    }),
  );
  const component = await mount(<WelcomeWizardHarness />);

  const run = component.getByRole("button", { name: "Run" });
  await expect(run).toBeDisabled();
  // The reason lives on the wrapping span so it surfaces on hover.
  await expect(component.locator(".setup-step-action-wrap")).toHaveAttribute(
    "title",
    "foo not found in PATH",
  );
});

test("an already-installed package shows as installed, not runnable", async ({
  mount,
  page,
}) => {
  await page.route("**/api/setup-tasks", route =>
    route.fulfill({
      json: {
        agent: AGENT_TASKS,
        sdk: [
          {
            ...SDK_TASKS[0],
            steps: [
              { ...SDK_TASKS[0].steps[0], completed: true },
              SDK_TASKS[0].steps[1],
            ],
          },
        ],
      },
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
    "https://evalut.io/n/docs/prompts",
  );
  await expect(docs).toHaveAttribute("target", "_blank");
});

test("Create New Prompt invokes the callback", async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness initialConfigured />);

  await expect(component.getByTestId("create-prompt-calls")).toHaveText("0");
  await component.getByRole("button", { name: "Create New Prompt" }).click();
  await expect(component.getByTestId("create-prompt-calls")).toHaveText("1");
});
