// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { SetupStep, SetupTask } from "../shared/setup-task.ts";

const AGENT_SETUP_DOMAIN = "evalut.io";

/** Setup instructions URL a coding agent is pointed at to wire up evalution. */
const AGENT_SETUP_URL = `https://${AGENT_SETUP_DOMAIN}/n/docs/setup.md`;

/** The prompt handed to a coding agent */
// exported for the tests
export const AGENT_SETUP_PROMPT = `Follow manual setup steps from ${AGENT_SETUP_URL}`;

/**
 * Every coding agent offered a one-click launcher in onboarding, in display
 * order. This is the single source of truth for which agents exist and their
 * task ids — each is a {@link SetupTask} whose lone {@link SetupStep} runs the
 * agent's CLI with the setup prompt queued up in an interactive terminal.
 *
 * Mirrors {@link AI_SDK_REGISTRY} in `../sdk/registry.ts`, but agents have no
 * adapter class, so they live here as plain tasks. `icon` keys into the
 * client's `ProviderIcon`.
 */
export const AGENT_REGISTRY: readonly SetupTask[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    icon: "Anthropic",
    steps: [
      {
        kind: "run_command",
        id: "launch",
        // The prompt must come before `--allowedTools`: that flag is variadic
        // (`<tools...>`), so anything after it — including the prompt — is
        // swallowed as another tool name and never reaches the CLI's positional.
        command: `claude "${AGENT_SETUP_PROMPT}" --allowedTools "WebFetch(domain:${AGENT_SETUP_DOMAIN})"`,
        label: "Claude Code",
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
        // See https://developers.openai.com/codex/agent-approvals-security#network-isolation
        command: `codex -c 'features.network_proxy.enabled=true' -c 'features.network_proxy.domains={ "${AGENT_SETUP_DOMAIN}" = "allow" }' -c 'sandbox_workspace_write.network_access=true' "${AGENT_SETUP_PROMPT}"`,
        label: "Codex",
      },
    ],
  },
];

/** Look up an agent {@link SetupTask} by its id, or `undefined` if none matches. */
export function findSetupTask(taskId: string): SetupTask | undefined {
  return AGENT_REGISTRY.find(task => task.id === taskId);
}

/**
 * Look up a step within an agent task by both ids, or `undefined` if either is
 * unknown.
 */
export function findSetupStep(
  taskId: string,
  stepId: string,
): SetupStep | undefined {
  return findSetupTask(taskId)?.steps.find(s => s.id === stepId);
}
