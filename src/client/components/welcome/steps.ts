// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { AllSetStep } from "./AllSetStep";
import { SetupStep } from "./SetupStep";
import type { WizardStep } from "./types";

/** ID of the final step, which the wizard jumps to once a config is loaded. */
export const ALL_SET_STEP_ID = "all-set";

/**
 * The ordered list of onboarding steps. To add or reorder steps, edit this
 * array — the wizard derives its progress header and navigation entirely from
 * it, so nothing else needs to change.
 */
export const WIZARD_STEPS: WizardStep[] = [
  //{ id: 'login', title: 'Sign in', canReturn: true, Component: LoginStep },
  { id: "setup", title: "Set up project", Component: SetupStep },
  { id: ALL_SET_STEP_ID, title: "You're all set", Component: AllSetStep },
];
