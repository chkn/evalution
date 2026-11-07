// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ReactNode } from "react";
import type { EvalCheckOutcome, EvalCounts } from "../../../eval/eval-types";
import { OUTCOME_GLYPH } from "../eval-summary";

/** Failures lead, as issues do among annotations. */
const OUTCOMES: EvalCheckOutcome[] = [
  "fail",
  "error",
  "pass",
  "scored",
  "skipped",
];

/** The `.annotation-chip-*` color an outcome shares with a like annotation. */
const CHIP_COLOR: Partial<Record<EvalCheckOutcome, string>> = {
  fail: "annotation-chip-issue",
  error: "annotation-chip-issue",
  pass: "annotation-chip-good",
  scored: "annotation-chip-note",
};

/**
 * Small colored count-pills, one per check outcome a trace has, or `empty`
 * when it has none — the checks' counterpart to `AnnotationCountBadges`.
 */
export function CheckCountBadges({
  counts,
  empty = null,
}: {
  counts: EvalCounts | undefined;
  empty?: ReactNode;
}) {
  const nonzero = OUTCOMES.filter(outcome => counts && counts[outcome] > 0);
  if (!counts || nonzero.length === 0) return empty;
  return (
    <span className="trace-annotation-counts">
      {nonzero.map(outcome => (
        <span
          key={outcome}
          className={`annotation-chip ${CHIP_COLOR[outcome] ?? ""}`}
          title={outcome}
        >
          <span className="annotation-chip-icon">{OUTCOME_GLYPH[outcome]}</span>
          {counts[outcome]}
        </span>
      ))}
    </span>
  );
}
