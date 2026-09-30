// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useState } from "react";
import type {
  EvalCheckResult,
  EvalResults,
  EvalRun,
  EvalRunProgress,
  EvalRunSummary,
} from "../../eval/eval-types";
import { cancelEvalRun, getEvalRun, getEvalRuns } from "../api";
import {
  cellKey,
  compareRuns,
  formatRate,
  gridRows,
  indexChecks,
  type OutcomeChange,
  summarizeArm,
} from "./eval-summary";
import {
  formatCost,
  formatDuration,
  formatTimestampCompact,
} from "./trace/format.ts";
import { EvalsIcon } from "./trace/icons.tsx";

interface Props {
  providerId: string;
  runId: string;
  /** Bumped on every eval change event, so the view refetches. */
  version: number;
  /** This run's latest progress, while it's in flight. */
  progress?: EvalRunProgress;
  onOpenTrace: (traceProviderId: string, traceId: string) => void;
}

/** The glyph a cell shows for its outcome. */
const OUTCOME_GLYPH: Record<EvalCheckResult["outcome"], string> = {
  pass: "✓",
  fail: "✗",
  error: "!",
  skipped: "–",
  scored: "",
};

/** A cell's text: the outcome's glyph, and the score when there is one. */
function cellText(result: EvalCheckResult | undefined): string {
  if (!result) return "";
  const score =
    result.score === undefined
      ? ""
      : Number.isInteger(result.score)
        ? String(result.score)
        : result.score.toFixed(2);
  return [OUTCOME_GLYPH[result.outcome], score].filter(Boolean).join(" ");
}

/**
 * One run's results: a summary strip per arm, and a row × (arm × check) grid
 * whose cells open the row's trace. Another run of the same eval can be
 * picked to compare against. See `specs/evals.md` §F.
 */
function EvalRunView({
  providerId,
  runId,
  version,
  progress,
  onOpenTrace,
}: Props) {
  const [run, setRun] = useState<EvalRun | null>(null);
  const [results, setResults] = useState<EvalResults>({ rows: [], checks: [] });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [others, setOthers] = useState<EvalRunSummary[]>([]);
  const [compareId, setCompareId] = useState("");
  const [changes, setChanges] = useState<OutcomeChange[] | null>(null);

  const done = progress?.done;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch as the run progresses and on its change events.
  useEffect(() => {
    let cancelled = false;
    getEvalRun(providerId, runId)
      .then(r => {
        if (cancelled) return;
        setRun(r.run);
        setResults(r.results);
      })
      .catch(err => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [providerId, runId, version, done]);

  const evalId = run?.evalId;
  useEffect(() => {
    if (!evalId) return;
    getEvalRuns(providerId, evalId)
      .then(rs => setOthers(rs.filter(r => r.id !== runId)))
      .catch(() => {});
  }, [providerId, evalId, runId]);

  useEffect(() => {
    if (!compareId || !run) {
      setChanges(null);
      return;
    }
    let cancelled = false;
    getEvalRun(providerId, compareId)
      .then(other => {
        if (cancelled) return;
        setChanges(
          compareRuns(
            { results, arms: run.arms },
            { results: other.results, arms: other.run.arms },
          ),
        );
      })
      .catch(err => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [providerId, compareId, run, results]);

  if (error && !run) {
    return <div className="eval-view eval-view-error">Error: {error}</div>;
  }
  if (!run) return <div className="eval-view" />;

  const checks = run.definition.checks;
  const checkLabel = (id: string) => {
    const c = checks.find(c => c.id === id);
    return c?.label ?? c?.uri.split("#").pop() ?? id;
  };
  const arms = run.arms.filter(a => !a.error);
  const byCell = indexChecks(results.checks);
  const rows = gridRows(results);
  const changed = new Map(
    (changes ?? []).map(c => [cellKey(c.armId, c.rowId, c.checkId), c]),
  );
  const status = progress?.status ?? run.status;
  const doneCount = progress?.done ?? results.rows.length;

  const selectedResult = selected ? byCell.get(selected) : undefined;
  const selectedRow = selected
    ? rows
        .find(r => r.rowId === selected.split(":")[1])
        ?.arms.get(selected.split(":")[0])
    : undefined;

  const openCell = (armId: string, rowId: string, checkId: string) => {
    const key = cellKey(armId, rowId, checkId);
    setSelected(key);
    const row = rows.find(r => r.rowId === rowId)?.arms.get(armId);
    if (row?.traceId && row.traceProviderId) {
      onOpenTrace(row.traceProviderId, row.traceId);
    }
  };

  return (
    <div className="eval-view eval-run-view">
      <div className="trace-view-header">
        <div className="trace-view-header-row">
          <div className="trace-view-title">
            <EvalsIcon size={14} />
            <span className="trace-view-name">
              {run.definition.name} · {formatTimestampCompact(run.startedAt)}
            </span>
          </div>
          <div className="trace-view-header-actions">
            {status === "running" && (
              <button
                type="button"
                className="dialog-btn-cancel"
                onClick={() =>
                  cancelEvalRun(providerId, runId).catch(err =>
                    setError(err.message),
                  )
                }
              >
                Cancel
              </button>
            )}
          </div>
        </div>
        <div className="trace-view-meta">
          <span className="trace-view-meta-item">
            {status === "running" ? (
              <>
                <progress max={run.total} value={doneCount} /> {doneCount}/
                {run.total}
              </>
            ) : (
              status
            )}
          </span>
          {run.startVersion && (
            <span
              className="trace-view-meta-item"
              title={`Commit ${run.startVersion}`}
            >
              {run.startVersion.slice(0, 7)}
            </span>
          )}
          {run.dirty && <span className="eval-badge">uncommitted changes</span>}
          {run.drifted && <span className="eval-badge">drifted</span>}
          {others.length > 0 && (
            <label className="trace-view-meta-item eval-compare">
              Compare with
              <select
                aria-label="Compare with run"
                value={compareId}
                onChange={e => setCompareId(e.target.value)}
              >
                <option value="">—</option>
                {others.map(o => (
                  <option key={o.id} value={o.id}>
                    {formatTimestampCompact(o.startedAt)} (
                    {o.arms.map(a => a.label).join(", ")})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {error && <div className="pg-exec-error">{error}</div>}

      <div className="eval-view-body">
        <div className="eval-arm-summaries">
          {run.arms.map(arm => {
            if (arm.error) {
              return (
                <div className="eval-arm-summary" key={arm.id}>
                  <div className="eval-arm-label">{arm.label}</div>
                  <div className="eval-check-missing">{arm.error}</div>
                </div>
              );
            }
            const s = summarizeArm(
              results,
              arm.id,
              checks.map(c => c.id),
            );
            return (
              <div className="eval-arm-summary" key={arm.id}>
                <div className="eval-arm-label">{arm.label}</div>
                {s.checks.map(c => (
                  <div className="eval-arm-check" key={c.checkId}>
                    <span>{checkLabel(c.checkId)}</span>
                    <span className="eval-arm-rate">
                      {c.meanScore !== undefined && c.passRate === undefined
                        ? `mean ${c.meanScore.toFixed(2)}`
                        : formatRate(c.passRate)}
                    </span>
                  </div>
                ))}
                <div className="eval-arm-stats">
                  {s.rowErrors > 0 && <span>{s.rowErrors} row errors</span>}
                  {s.totalCost !== undefined && (
                    <span>{formatCost(s.totalCost)}</span>
                  )}
                  {s.p50Duration !== undefined && (
                    <span>
                      p50 {formatDuration(s.p50Duration)} · p95{" "}
                      {formatDuration(s.p95Duration ?? s.p50Duration)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {changes && (
          <p className="eval-compare-summary">
            {changes.length === 0
              ? "No outcome changed."
              : `${changes.filter(c => c.regressed).length} regressed, ${
                  changes.filter(c => !c.regressed).length
                } otherwise changed — outlined below.`}
          </p>
        )}

        <div className="eval-grid-scroll">
          <table className="eval-grid">
            <thead>
              <tr>
                <th rowSpan={arms.length > 1 ? 2 : 1}>Row</th>
                {arms.length > 1
                  ? arms.map(a => (
                      <th key={a.id} colSpan={checks.length || 1}>
                        {a.label}
                      </th>
                    ))
                  : checks.map(c => <th key={c.id}>{checkLabel(c.id)}</th>)}
              </tr>
              {arms.length > 1 && (
                <tr>
                  {arms.flatMap(a =>
                    checks.map(c => (
                      <th key={`${a.id}:${c.id}`}>{checkLabel(c.id)}</th>
                    )),
                  )}
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.rowId}>
                  <td className="eval-grid-row">{row.rowIndex + 1}</td>
                  {arms.flatMap(arm => {
                    const rowResult = row.arms.get(arm.id);
                    if (rowResult && rowResult.status !== "ok") {
                      return [
                        <td
                          key={arm.id}
                          colSpan={checks.length || 1}
                          className={`eval-cell eval-cell-${rowResult.status}`}
                          title={rowResult.error}
                        >
                          {rowResult.status}: {rowResult.error}
                        </td>,
                      ];
                    }
                    return checks.map(c => {
                      const key = cellKey(arm.id, row.rowId, c.id);
                      const r = byCell.get(key);
                      const change = changed.get(key);
                      return (
                        <td
                          key={key}
                          className={[
                            "eval-cell",
                            r && `eval-cell-${r.outcome}`,
                            selected === key && "eval-cell-selected",
                            change &&
                              (change.regressed
                                ? "eval-cell-regressed"
                                : "eval-cell-changed"),
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          title={
                            [
                              r?.message,
                              change && `was ${change.before}`,
                              rowResult?.traceIncomplete &&
                                "The trace was incomplete when checks ran",
                            ]
                              .filter(Boolean)
                              .join("\n") || undefined
                          }
                          onClick={() => openCell(arm.id, row.rowId, c.id)}
                        >
                          {cellText(r)}
                        </td>
                      );
                    });
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedResult && (
          <div className="eval-cell-detail">
            <div className="eval-arm-label">
              Row {(selectedRow?.rowIndex ?? 0) + 1} ·{" "}
              {checkLabel(selectedResult.checkId)} · {selectedResult.outcome}
              {selectedResult.score !== undefined &&
                ` (${selectedResult.score})`}
            </div>
            {selectedResult.message && (
              <pre className="eval-cell-message">{selectedResult.message}</pre>
            )}
            {selectedResult.details !== undefined && (
              <pre className="eval-cell-message">
                {JSON.stringify(selectedResult.details, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default EvalRunView;
