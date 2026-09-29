// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { createPersistentValue } from "./persistent-value";

/**
 * Whether an unsaved edit writes into the prompt's file once it settles —
 * set in the Load/Save settings section, read wherever a prompt tab decides
 * whether to autosave.
 */
export const autosave = createPersistentValue<boolean>(
  "evalution.autosave",
  false,
  raw => raw === "true",
);
