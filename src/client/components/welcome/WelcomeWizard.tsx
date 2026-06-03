import { useState } from 'react';
import { WIZARD_STEPS } from './steps';
import type { WizardStep } from './types';

interface WelcomeWizardProps {
  /** Opens the existing "create new prompt" flow. */
  onCreatePrompt: () => void;
  /** Step registry override, primarily for testing. Defaults to {@link WIZARD_STEPS}. */
  steps?: WizardStep[];
}

/**
 * The first-run onboarding wizard shown in the Welcome tab when a project has
 * no prompts yet. Steps are data-driven (see {@link WIZARD_STEPS}); this shell
 * only tracks the current index and renders the progress header.
 */
export function WelcomeWizard({ onCreatePrompt, steps = WIZARD_STEPS }: WelcomeWizardProps) {
  const [index, setIndex] = useState(0);

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
                      <span className="welcome-progress-dot">{i + 1}</span>
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
          />
        </div>
      </div>
    </div>
  );
}
