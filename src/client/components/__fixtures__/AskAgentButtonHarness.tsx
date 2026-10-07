// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { AgentInfo } from "../../../shared/agent";
import { AskAgentButton } from "../AskAgentButton";
import "../../styles.css";

const ALL_AGENTS: AgentInfo[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    icon: "Anthropic",
    disabledReason: "claude not found in PATH",
  },
  { id: "codex", label: "Codex", icon: "OpenAI" },
];

interface AskAgentButtonHarnessProps {
  /** How many agents the host lists — `0` for one that can't launch any. */
  count?: number;
}

/**
 * Mounts {@link AskAgentButton} with the first `count` agents — Claude Code
 * not installed, Codex installed — and shows the id of the last one asked in
 * `[data-testid="asked"]`.
 */
export function AskAgentButtonHarness({
  count = ALL_AGENTS.length,
}: AskAgentButtonHarnessProps) {
  const [asked, setAsked] = useState("");
  return (
    <div>
      <AskAgentButton
        agents={ALL_AGENTS.slice(0, count)}
        onAsk={agent => setAsked(agent.id)}
      />
      <span data-testid="asked">{asked}</span>
    </div>
  );
}
