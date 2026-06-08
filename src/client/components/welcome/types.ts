import type { ComponentType } from 'react';

/** Props passed to every onboarding wizard step. */
export interface WizardStepProps {
  /** Advance to the next step. No-op on the last step. */
  onNext: () => void;
  /** Whether this is the first step. */
  isFirst: boolean;
  /** Whether this is the last step. */
  isLast: boolean;
  /** Opens the existing "create new prompt" flow. */
  onCreatePrompt: () => void;
  /**
   * Opens an interactive terminal tab (split to the right) with `command`
   * queued up, ready for the user to run. Optional so steps degrade gracefully
   * when no host is wired up (e.g. in isolated component tests).
   */
  onOpenTerminal?: (command: string, label?: string) => void;
}

/**
 * A single onboarding step. Steps are fully self-contained so the wizard can
 * add, remove, or reorder them just by editing the registry array.
 */
export interface WizardStep {
  /** Stable identifier, also used as the React key and progress label anchor. */
  id: string;
  /** Short title shown in the wizard's progress header. */
  title: string;
  /**
   * Whether the user may navigate back to this step after leaving it. When
   * `true`, the step appears as a clickable link in the progress header once
   * it has been completed. Defaults to `false`.
   */
  canReturn?: boolean;
  /** Renders the step body. */
  Component: ComponentType<WizardStepProps>;
}
