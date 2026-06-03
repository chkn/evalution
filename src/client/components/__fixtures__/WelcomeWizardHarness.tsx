import { useState } from 'react';
import { WelcomeWizard } from '../welcome/WelcomeWizard';

/**
 * Mounts {@link WelcomeWizard} and surfaces `onCreatePrompt` invocations into
 * the DOM (as a count) so Playwright can assert the callback fired without
 * crossing the React boundary.
 */
export function WelcomeWizardHarness() {
  const [createPromptCalls, setCreatePromptCalls] = useState(0);
  return (
    <div className="main-content" style={{ width: 700, height: 700 }}>
      <div data-testid="create-prompt-calls">{createPromptCalls}</div>
      <WelcomeWizard onCreatePrompt={() => setCreatePromptCalls(c => c + 1)} />
    </div>
  );
}
