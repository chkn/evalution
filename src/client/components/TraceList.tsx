// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TraceSummary } from '../../shared/types';

interface TraceListProps {
  traces: TraceSummary[];
  loading: boolean;
  error: string | null;
  selectedTraceKey: string | null;
  onSelect: (trace: TraceSummary) => void;
}

const traceKey = (t: { providerId: string; id: string }) => `${t.providerId}:${t.id}`;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function TraceList({ traces, loading, error, selectedTraceKey, onSelect }: TraceListProps) {
  if (loading) {
    return (
      <>
        <div className="section-panel-header">Traces</div>
        <div className="section-panel-body">
          <div className="tree-status">Loading...</div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="section-panel-header">Traces</div>
        <div className="section-panel-body">
          <div className="tree-status tree-error">Error: {error}</div>
        </div>
      </>
    );
  }

  if (traces.length === 0) {
    return (
      <>
        <div className="section-panel-header">Traces</div>
        <div className="section-panel-body">
          <div className="tree-empty-state">
            <p>No traces yet.</p>
            <p className="trace-list-hint">Run a prompt to create one.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="section-panel-header">Traces</div>
      <div className="section-panel-body trace-list">
        {traces.map((trace) => {
          const key = traceKey(trace);
          const isSelected = key === selectedTraceKey;
          const duration = trace.endTime !== undefined ? trace.endTime - trace.startTime : undefined;
          return (
            <div
              key={key}
              className={`trace-list-row${isSelected ? ' trace-list-row-selected' : ''}`}
              onClick={() => onSelect(trace)}
              title={trace.name}
            >
              <div className="trace-list-row-top">
                <span className={`trace-status-dot trace-status-${trace.status}`} />
                <span className="trace-list-name">{trace.name}</span>
              </div>
              <div className="trace-list-row-meta">
                <span>{formatTime(trace.startTime)}</span>
                <span>{trace.spanCount} span{trace.spanCount === 1 ? '' : 's'}</span>
                <span>{duration !== undefined ? formatDuration(duration) : 'running…'}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default TraceList;
