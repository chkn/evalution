import { LoginStep } from './LoginStep';
import { SetupStep } from './SetupStep';
import type { WizardStep } from './types';

/**
 * The ordered list of onboarding steps. To add or reorder steps, edit this
 * array — the wizard derives its progress header and navigation entirely from
 * it, so nothing else needs to change.
 */
export const WIZARD_STEPS: WizardStep[] = [
  { id: 'login', title: 'Sign in', canReturn: true, Component: LoginStep },
  { id: 'setup', title: 'Set up project', Component: SetupStep },
];
