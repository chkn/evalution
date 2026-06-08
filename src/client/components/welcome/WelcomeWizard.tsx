import { useEffect, useState } from 'react';
import { ALL_SET_STEP_ID, WIZARD_STEPS } from './steps';
import type { WizardStep } from './types';

interface WelcomeWizardProps {
  /** Opens the existing "create new prompt" flow. */
  onCreatePrompt: () => void;
  /** Opens an interactive terminal tab with `command` queued up. */
  onOpenTerminal?: (command: string, label?: string) => void;
  /**
   * Whether a project config is loaded. When `true`, the wizard jumps straight
   * to the final "you're all set" step — both on first render (config already
   * present at launch) and when it flips to `true` after the user creates one.
   */
  configured?: boolean;
  /** Step registry override, primarily for testing. Defaults to {@link WIZARD_STEPS}. */
  steps?: WizardStep[];
}

/**
 * The first-run onboarding wizard shown in the Welcome tab when a project has
 * no prompts yet. Steps are data-driven (see {@link WIZARD_STEPS}); this shell
 * only tracks the current index and renders the progress header.
 */
export function WelcomeWizard({ onCreatePrompt, onOpenTerminal, configured = false, steps = WIZARD_STEPS }: WelcomeWizardProps) {
  const allSetIndex = steps.findIndex(s => s.id === ALL_SET_STEP_ID);
  // Start on the final step if we already have a config; otherwise at the top.
  const [index, setIndex] = useState(configured && allSetIndex >= 0 ? allSetIndex : 0);

  // Advance to the final step once a config is loaded (e.g. after the user
  // creates one and the server restarts with it).
  useEffect(() => {
    if (configured && allSetIndex >= 0) setIndex(allSetIndex);
  }, [configured, allSetIndex]);

  const step = steps[index];
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;
  const onNext = () => setIndex(i => Math.min(i + 1, steps.length - 1));

  const StepComponent = step.Component;

  return (
    <div className="welcome">
      <div className="welcome-card">
        <header className="welcome-header">
          <img className="welcome-logo" src="/favicon.svg" width="36" height="49" alt="" />
          <ol className="welcome-progress">
            {steps.map((s, i) => {
              const state = i === index ? 'active' : i < index ? 'done' : 'todo';
              // A completed step is navigable only if it opted in via canReturn.
              const canNavigate = i < index && !!s.canReturn;
              return (
                <li key={s.id} className={`welcome-progress-${state}`}>
                  {canNavigate ? (
                    <button type="button" className="welcome-progress-btn" onClick={() => setIndex(i)}>
                      <span className="welcome-progress-dot">{i + 1}</span>
                      <span className="welcome-progress-label">{s.title}</span>
                    </button>
                  ) : (
                    <>
                      {steps.length > 1 && <span className="welcome-progress-dot">{i + 1}</span>}
                      <span className="welcome-progress-label">{s.title}</span>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </header>

        <div className="welcome-step-body">
          <StepComponent
            onNext={onNext}
            isFirst={isFirst}
            isLast={isLast}
            onCreatePrompt={onCreatePrompt}
            onOpenTerminal={onOpenTerminal}
          />
        </div>
      </div>
    </div>
  );
}
