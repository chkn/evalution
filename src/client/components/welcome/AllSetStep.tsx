// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { WizardStepProps } from "./types";

/** Guide the user is pointed at once their project is configured. */
const GETTING_STARTED_URL = "https://evalut.io/n/docs/getting-started";

/**
 * Final onboarding step, shown once a project config is loaded. Confirms the
 * setup worked and offers the two natural next moves: create a first prompt, or
 * read the docs.
 */
export function AllSetStep({ onCreatePrompt }: WizardStepProps) {
  return (
    <div className="setup-allset">
      <h3>You're all set! 🎉</h3>
      <p className="welcome-subtitle">
        Create your first prompt to start iterating, or browse the docs to see
        what's possible.
      </p>
      <a
        className="welcome-link"
        href={GETTING_STARTED_URL}
        target="_blank"
        rel="noreferrer"
      >
        Read the docs ↗
      </a>
      <div className="setup-actions">
        <button
          type="button"
          className="welcome-btn-primary"
          onClick={onCreatePrompt}
        >
          Create New Prompt
        </button>
      </div>
    </div>
  );
}
