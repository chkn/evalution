// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The eval editor's proposals: bindings it fills in so a dataset made from
 * the prompt binds without any clicking, and the problems list that gates
 * Run. Pure. See `specs/evals.md` §F.1.
 */

export {
  type Prefilled,
  type PrefillInput,
  prefillBindings,
} from "../../shared/eval-prefill";
export { evalProblems } from "../../shared/eval-problems";
