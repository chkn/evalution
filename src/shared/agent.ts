// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Shared, dependency-free types for launching a coding agent from the UI, and
 * for naming what an interactive terminal runs.
 *
 * Imported by both the browser client and the server, so it must stay free of
 * any Node- or DOM-specific imports.
 */

/** URL for requesting support for a coding agent we don't list. */
export const OTHER_AGENT_URL =
  "https://github.com/chkn/evalution/issues/new?template=agent-request.yml";

/** A coding agent evalution knows how to launch, as `GET /api/agents` lists it. */
export interface AgentInfo {
  /** Stable identifier, e.g. `claude-code`. */
  id: string;
  /** Display name, e.g. `Claude Code`. */
  label: string;
  /** Icon identifier, mapped to a bundled asset by the client's `ProviderIcon`. */
  icon: string;
  /**
   * Why the agent can't be launched — its CLI isn't on `PATH` — or absent
   * when it can.
   */
  disabledReason?: string;
}

/**
 * What the user was looking at when they asked a coding agent for help. The
 * server looks it up and tells the agent about it — the client only names it,
 * so it can't put words in the agent's instructions.
 */
export type AgentContext =
  | { type: "prompt"; providerId: string; promptId: string }
  | { type: "trace"; providerId: string; traceId: string }
  | { type: "dataset"; providerId: string; datasetId: string }
  | { type: "eval"; providerId: string; evalId: string };

/**
 * What an interactive terminal runs, by reference: the server resolves the
 * actual command line from its own registries, never from the client.
 */
export type TerminalTarget =
  /** An onboarding setup step (see `./setup-task.ts`). */
  | { kind: "setup"; taskId: string; stepId: string }
  /** A coding agent, launched with `context` and evalution's MCP server. */
  | { kind: "agent"; agentId: string; context: AgentContext };

/**
 * Parses `value` as an {@link AgentContext}, or returns `undefined` if it
 * isn't one — for input that came over the wire.
 */
export function parseAgentContext(value: unknown): AgentContext | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { type, providerId } = value as Record<string, unknown>;
  if (typeof providerId !== "string" || !Object.hasOwn(ID_KEYS, type as string))
    return undefined;
  const idKey = ID_KEYS[type as AgentContext["type"]];
  const id = (value as Record<string, unknown>)[idKey];
  if (typeof id !== "string") return undefined;
  // Rebuilt rather than passed through, so nothing beyond these fields rides along.
  return { type, providerId, [idKey]: id } as AgentContext;
}

/** The field each {@link AgentContext} type names its entity by. */
const ID_KEYS = {
  prompt: "promptId",
  trace: "traceId",
  dataset: "datasetId",
  eval: "evalId",
} as const satisfies Record<AgentContext["type"], string>;

/**
 * Parses `value` as a {@link TerminalTarget}, or returns `undefined` if it
 * isn't one — for input that came over the wire.
 */
export function parseTerminalTarget(
  value: unknown,
): TerminalTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind === "setup") {
    return typeof v.taskId === "string" && typeof v.stepId === "string"
      ? { kind: "setup", taskId: v.taskId, stepId: v.stepId }
      : undefined;
  }
  if (v.kind === "agent" && typeof v.agentId === "string") {
    const context = parseAgentContext(v.context);
    return context && { kind: "agent", agentId: v.agentId, context };
  }
  return undefined;
}
