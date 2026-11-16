// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { LINK_HOST, SETUP_DOCS_MARKDOWN_URL } from "../shared/links.ts";
import type { SetupStep, SetupTask } from "../shared/setup-task.ts";
import {
  type AgentCommandBuilder,
  ClaudeCodeCommandBuilder,
  CodexCommandBuilder,
} from "./command-builder.ts";

/** The site the setup docs' link redirects to. */
const DOCS_DOMAIN = "evalut.io";

/** The prompt handed to a coding agent */
// exported for the tests
export const AGENT_SETUP_PROMPT = `Follow manual setup steps from ${SETUP_DOCS_MARKDOWN_URL}`;

/** A coding agent evalution can launch in a terminal. */
export interface CodingAgent {
  /** Stable identifier, also the agent's setup {@link SetupTask.id}. */
  id: string;
  /** Display name, e.g. `Claude Code`. */
  label: string;
  /** Icon identifier, keyed into the client's `ProviderIcon`. */
  icon: string;
  /** A fresh builder for this agent's launch command. */
  commandBuilder(): AgentCommandBuilder;
}

/**
 * Every coding agent evalution can launch, in display order. This is the
 * single source of truth for which agents exist: onboarding offers each as a
 * one-click setup launcher ({@link AGENT_REGISTRY}), and the "Ask" button on
 * the prompt, trace, dataset, and eval views offers those whose CLI is
 * installed.
 */
export const CODING_AGENTS: readonly CodingAgent[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    icon: "Anthropic",
    commandBuilder: () => new ClaudeCodeCommandBuilder(),
  },
  {
    id: "codex",
    label: "Codex",
    icon: "OpenAI",
    commandBuilder: () => new CodexCommandBuilder(),
  },
];

/** Look up a {@link CodingAgent} by its id, or `undefined` if none matches. */
export function findAgent(agentId: string): CodingAgent | undefined {
  return CODING_AGENTS.find(agent => agent.id === agentId);
}

/**
 * Every coding agent offered a one-click launcher in onboarding, in display
 * order — each is a {@link SetupTask} whose lone {@link SetupStep} runs the
 * agent's CLI with the setup prompt queued up in an interactive terminal.
 *
 * Mirrors {@link AI_SDK_SETUP_TASKS} in `../sdk/registry.ts`, but agents have no
 * adapter class, so they're derived here from {@link CODING_AGENTS}.
 */
export const AGENT_REGISTRY: readonly SetupTask[] = CODING_AGENTS.map(
  agent => ({
    id: agent.id,
    label: agent.label,
    icon: agent.icon,
    steps: [
      {
        kind: "run_command",
        id: "launch",
        // The agent may fetch the setup docs without asking: the link, and
        // the page it redirects to.
        command: agent
          .commandBuilder()
          .setPrompt(AGENT_SETUP_PROMPT)
          .addAllowedDomain(LINK_HOST)
          .addAllowedDomain(DOCS_DOMAIN)
          .build(),
        label: agent.label,
      },
    ],
  }),
);

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
