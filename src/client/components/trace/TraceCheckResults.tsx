// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useState } from "react";
import type { TraceCheckResult } from "../../../eval/eval-types";
import { getTraceCheckResults } from "../../api";

/**
 * The trace's check results, from every eval run that made it — each check's
 * outcome and message beside the trace it judged. See `specs/evals.md` §F.
 * Renders nothing when no eval ran the trace.
 */
export function TraceCheckResults({
  providerId,
  traceId,
  version,
}: {
  providerId: string;
  traceId: string;
  /** Bumped on eval changes, so results that land later show up. */
  version?: number;
}) {
  const [results, setResults] = useState<TraceCheckResult[]>([]);
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

  if (results.length === 0) return null;
  return (
    <section className="trace-checks" aria-label="Checks">
      {results.map(r => (
        <div
          key={`${r.runId}:${r.armId}:${r.checkId}`}
          className={`trace-check trace-check-${r.outcome}`}
        >
          <span className="trace-check-outcome">
            {r.outcome}
            {r.score !== undefined && ` ${r.score}`}
          </span>
          <span className="trace-check-label">{r.checkLabel}</span>
          <span className="trace-check-meta">
            {r.evalName} · {r.armLabel}
          </span>
          {r.message && <div className="trace-check-message">{r.message}</div>}
        </div>
      ))}
    </section>
  );
}
