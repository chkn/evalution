// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useLayoutEffect, useState } from "react";
import type { TraceEvalRun } from "../../../shared/types";
import { getTraceCheckResults } from "../../api";
import { CheckCountBadges } from "./CheckCountBadges.tsx";
import {
  countOutcomes,
  groupCheckRuns,
  type OpenEvalRun,
  type ProvidedCheckResult,
} from "./check-runs.ts";
import {
  openCollapsedRuns,
  saveCollapsedRuns,
  traceEntryKey,
} from "./collapsed-checks.ts";
import { ChevronIcon } from "./icons.tsx";

/**
 * The trace's check results, from every eval run that made it — each check's
 * outcome and message beside the trace it judged, under a heading naming the
 * eval and version once and linking to the run. See `specs/evals.md` §F.
 * The run the trace came from gets its heading even with no checks to show.
 * A run with checks collapses to its heading and a count chip per outcome;
 * which runs are collapsed is remembered for the last traces opened.
 * Renders nothing when no eval ran the trace.
 */
export function TraceCheckResults({
  providerId,
  traceId,
  version,
  evalRun,
  onOpenRun,
}: {
  providerId: string;
  traceId: string;
  /** Bumped on eval changes, so results that land later show up. */
  version?: number;
  /** The eval run the trace came from, if any. */
  evalRun?: TraceEvalRun;
  /** Opens the run a heading names. Without it, the heading isn't a link. */
  onOpenRun?: OpenEvalRun;
}) {
  const [results, setResults] = useState<ProvidedCheckResult[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on eval changes too.
  useEffect(() => {
    let cancelled = false;
    getTraceCheckResults(providerId, traceId)
      .then(r => !cancelled && setResults(r))
      .catch(() => !cancelled && setResults([]));
    return () => {
      cancelled = true;
    };
  }, [providerId, traceId, version]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const traceKey = traceEntryKey(providerId, traceId);
  const runs = groupCheckRuns(results, evalRun);
  const hasRuns = runs.length > 0;
  // Opening a trace that eval runs touched recalls its collapsed runs, and
  // counts it among the last opened — before paint, so a collapsed run
  // doesn't flash open.
  useLayoutEffect(() => {
    if (hasRuns) setCollapsed(openCollapsedRuns(traceKey));
  }, [traceKey, hasRuns]);
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    saveCollapsedRuns(traceKey, next);
  };

  if (!hasRuns) return null;
  return (
    <section className="trace-checks" aria-label="Checks">
      {runs.map(run => {
        const key = `${run.runId}:${run.armId}`;
        const heading = `${run.evalName} · ${run.armLabel}`;
        const hasResults = run.results.length > 0;
        const open = !collapsed.has(key);
        return (
          <div key={key} className="trace-check-run">
            <div className="trace-check-run-header">
              {hasResults && (
                <button
                  type="button"
                  className="trace-check-run-toggle"
                  aria-expanded={open}
                  aria-label={open ? "Collapse checks" : "Expand checks"}
                  onClick={() => toggle(key)}
                >
                  <ChevronIcon open={open} />
                </button>
              )}
              {onOpenRun ? (
                <button
                  type="button"
                  className="trace-check-run-link"
                  onClick={() =>
                    onOpenRun(
                      run.providerId,
                      { id: run.runId, startedAt: run.startedAt },
                      run.evalName,
                    )
                  }
                  title="Open eval run"
                >
                  {heading} ↗
                </button>
              ) : (
                <span className="trace-check-run-link">{heading}</span>
              )}
              <CheckCountBadges counts={countOutcomes(run.results)} />
            </div>
            {open &&
              run.results.map(r => (
                <div
                  key={r.checkId}
                  className={`trace-check trace-check-${r.outcome}`}
                >
                  <span className="trace-check-outcome">
                    {r.outcome}
                    {r.score !== undefined && ` ${r.score}`}
                  </span>
                  <span className="trace-check-label">{r.checkLabel}</span>
                  {r.message && (
                    <div className="trace-check-message">{r.message}</div>
                  )}
                </div>
              ))}
          </div>
        );
      })}
    </section>
  );
}
