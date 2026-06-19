// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { WelcomeWizard } from "../welcome/WelcomeWizard";

interface WelcomeWizardHarnessProps {
  /** Initial value for the wizard's `configured` flag. */
  initialConfigured?: boolean;
}

/**
 * Mounts {@link WelcomeWizard} and surfaces `onCreatePrompt` invocations into
 * the DOM (as a count) so Playwright can assert the callback fired without
 * crossing the React boundary. A button lets tests flip `configured` to mimic
 * a config being loaded at runtime.
 */
export function WelcomeWizardHarness({
  initialConfigured = false,
}: WelcomeWizardHarnessProps) {
  const [createPromptCalls, setCreatePromptCalls] = useState(0);
  const [configured, setConfigured] = useState(initialConfigured);
  const [lastTerminal, setLastTerminal] = useState("");
  return (
    <div className="main-content" style={{ width: 700, height: 700 }}>
      <div data-testid="create-prompt-calls">{createPromptCalls}</div>
      <div data-testid="last-terminal">{lastTerminal}</div>
      <button
        type="button"
        data-testid="load-config"
        onClick={() => setConfigured(true)}
      >
        load config
      </button>
      <WelcomeWizard
        configured={configured}
        onCreatePrompt={() => setCreatePromptCalls(c => c + 1)}
        onOpenTerminal={(taskId, stepId, command, label) =>
          setLastTerminal(`${taskId}|${stepId}|${command}|${label ?? ""}`)
        }
      />
    </div>
  );
}
