// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useState } from "react";
import type { TraceEvalRun } from "../../../shared/types";
import { getTraceCheckResults } from "../../api";
import {
  groupCheckRuns,
  type OpenEvalRun,
  type ProvidedCheckResult,
} from "./check-runs.ts";

/**
 * The trace's check results, from every eval run that made it — each check's
 * outcome and message beside the trace it judged, under a heading naming the
 * eval and version once and linking to the run. See `specs/evals.md` §F.
 * The run the trace came from gets its heading even with no checks to show.
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

  const runs = groupCheckRuns(results, evalRun);
  if (runs.length === 0) return null;
  return (
    <section className="trace-checks" aria-label="Checks">
      {runs.map(run => {
        const heading = `${run.evalName} · ${run.armLabel}`;
        return (
          <div key={`${run.runId}:${run.armId}`} className="trace-check-run">
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
            {run.results.map(r => (
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
