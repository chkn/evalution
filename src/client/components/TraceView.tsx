// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useState } from "react";
import type {
  PromptID,
  Span,
  Trace,
  TraceStreamEvent,
} from "../../shared/types";
import { getTrace, subscribeTraceEvents } from "../api";

interface Props {
  providerId: string;
  traceId: string;
  /** Span to select and scroll to on first render. */
  initialSpanId?: string;
  /** Called when the user asks to open a linked prompt in a split pane. */
  onOpenPrompt?: (prompt: PromptID) => void;
}

interface TraceState {
  trace: Trace | null;
  spans: Span[];
}

function TraceView({
  providerId,
  traceId,
  initialSpanId,
  onOpenPrompt,
}: Props) {
  const [state, setState] = useState<TraceState>({ trace: null, spans: [] });
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(
    initialSpanId ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getTrace(providerId, traceId)
      .then(data => {
        if (cancelled) return;
        setState({ trace: data.trace, spans: data.spans });
      })
      .catch(err => {
        if (!cancelled) setError(err.message);
      });

    const unsubscribe = subscribeTraceEvents(
      providerId,
      traceId,
      (event: TraceStreamEvent) => {
        setState(prev => applyEvent(prev, event));
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [providerId, traceId]);

  const rows = useMemo(() => buildRows(state.spans), [state.spans]);
  const window = useMemo(
    () => computeWindow(state.trace, state.spans),
    [state.trace, state.spans],
  );

  if (error) {
    return <div className="trace-view trace-view-error">Error: {error}</div>;
  }

  if (!state.trace) {
    return (
      <div className="trace-view">
        <div className="trace-view-loading">Loading trace…</div>
      </div>
    );
  }

  const totalDuration = Math.max(1, window.end - window.start);

  return (
    <div className="trace-view">
      <div className="trace-view-header">
        <div className="trace-view-title">
          <span
            className={`trace-status-dot trace-status-${state.trace.status}`}
          />
          <span>{state.trace.name}</span>
          <span className="trace-view-timestamp">
            {formatTimestamp(state.trace.startTime)}
          </span>
        </div>
        <div className="trace-view-meta">
          <span>
            {state.spans.length} span{state.spans.length === 1 ? "" : "s"}
          </span>
          <span>{formatDuration(totalDuration)}</span>
        </div>
      </div>

      <div className="trace-waterfall">
        {rows.map(row => {
          const span = row.span;
          const relStart = span.startTime - window.start;
          const spanEnd = span.endTime ?? window.end;
          const relEnd = spanEnd - window.start;
          const leftPct = (relStart / totalDuration) * 100;
          const widthPct = Math.max(
            0.5,
            ((relEnd - relStart) / totalDuration) * 100,
          );
          const isSelected = span.id === selectedSpanId;
          const running = span.endTime === undefined;
          const duration = running ? undefined : spanEnd - span.startTime;

          const hasError = span.status === "error";
          // Only resolved prompts (provider-scoped) can be opened; an unresolved
          // global id wouldn't match any prompt in the list.
          const canOpenPrompt = !!(span.prompt?.providerId && onOpenPrompt);
          const handleOpenPrompt = canOpenPrompt
            ? () => onOpenPrompt!(span.prompt!)
            : undefined;
          return (
            <div
              key={span.id}
              className={`trace-row${isSelected ? " trace-row-expanded" : ""}${hasError ? " trace-row-error" : ""}`}
            >
              <div className="trace-row-main">
                <div
                  className="trace-row-label"
                  style={{ paddingLeft: row.depth * 16 }}
                >
                  <button
                    type="button"
                    className="trace-row-disclosure"
                    onClick={() =>
                      setSelectedSpanId(isSelected ? null : span.id)
                    }
                    aria-label={isSelected ? "Collapse" : "Expand"}
                  >
                    <DisclosureChevron expanded={isSelected} />
                  </button>
                  <SpanErrorIcon visible={hasError} />
                  {span.kind !== "DEFAULT" && <SpanKindPill kind={span.kind} />}
                  <span
                    className={`trace-row-name${canOpenPrompt ? " trace-row-name-linked" : ""}`}
                    onClick={handleOpenPrompt}
                  >
                    {span.name}
                  </span>
                  {canOpenPrompt && (
                    <button
                      type="button"
                      className="trace-row-prompt-btn"
                      onClick={handleOpenPrompt}
                      title="Open prompt"
                    >
                      <PromptLinkIcon />
                    </button>
                  )}
                </div>
                <div className="trace-row-duration">
                  {duration !== undefined
                    ? formatDuration(duration)
                    : running
                      ? "…"
                      : ""}
                </div>
                <div className="trace-row-bar-track">
                  <div
                    className={`trace-row-bar trace-row-bar-${span.kind}${running ? " trace-row-bar-running" : ""}`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  />
                </div>
              </div>
              {isSelected && (
                <div className="trace-row-details">
                  <SpanDetails span={span} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function applyEvent(prev: TraceState, event: TraceStreamEvent): TraceState {
  switch (event.type) {
    case "span-start":
    case "span-end":
    case "span-update": {
      const existing = prev.spans.findIndex(s => s.id === event.span.id);
      const spans =
        existing >= 0
          ? prev.spans.map((s, i) => (i === existing ? event.span : s))
          : [...prev.spans, event.span];
      return { ...prev, spans };
    }
    case "trace-update":
    case "trace-end":
      return { ...prev, trace: event.trace };
    default:
      return prev;
  }
}

interface Row {
  span: Span;
  depth: number;
}

function buildRows(spans: Span[]): Row[] {
  const byParent = new Map<string | undefined, Span[]>();
  for (const span of spans) {
    const list = byParent.get(span.parentId) ?? [];
    list.push(span);
    byParent.set(span.parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.startTime - b.startTime);
  }

  const rows: Row[] = [];
  const visit = (parentId: string | undefined, depth: number) => {
    const children = byParent.get(parentId) ?? [];
    for (const span of children) {
      rows.push({ span, depth });
      visit(span.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return rows;
}

function computeWindow(
  trace: Trace | null,
  spans: Span[],
): { start: number; end: number } {
  if (!trace) return { start: 0, end: 1 };
  let start = trace.startTime;
  let end = trace.endTime ?? trace.startTime;
  for (const span of spans) {
    if (span.startTime < start) start = span.startTime;
    const spanEnd = span.endTime ?? span.startTime;
    if (spanEnd > end) end = spanEnd;
  }
  if (end <= start) end = start + 1;
  return { start, end };
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function SpanKindPill({ kind }: { kind: Span["kind"] }) {
  return <span className={`span-kind-pill span-kind-${kind}`}>{kind}</span>;
}

function SpanErrorIcon({ visible }: { visible: boolean }) {
  return (
    <svg
      className="span-error-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-label={visible ? "Error" : undefined}
      aria-hidden={!visible}
      style={{ visibility: visible ? "visible" : "hidden" }}
    >
      <path
        d="M7.06 2.8 1.8 12.2A1 1 0 0 0 2.7 13.7h10.6a1 1 0 0 0 .9-1.5L9.0 2.8a1.15 1.15 0 0 0-1.94 0Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.5v3M8 11v.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`trace-disclosure-icon${expanded ? " trace-disclosure-icon-open" : ""}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
    >
      <path
        d="M2.5 3.5 5 6.5l2.5-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PromptLinkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

function SpanDetails({ span }: { span: Span }) {
  const rows: { label: string; value: React.ReactNode }[] = [];

  rows.push({ label: "ID", value: <code>{span.id}</code> });
  rows.push({ label: "Kind", value: span.kind });
  if (span.status) rows.push({ label: "Status", value: span.status });
  if (span.errorMessage) {
    rows.push({
      label: "Error",
      value: <pre className="span-details-error">{span.errorMessage}</pre>,
    });
  }

  if (span.llm) {
    const { llm } = span;
    if (llm.provider) rows.push({ label: "Provider", value: llm.provider });
    if (llm.model) rows.push({ label: "Model", value: llm.model });
    if (llm.promptTokens !== undefined || llm.completionTokens !== undefined) {
      rows.push({
        label: "Tokens",
        value: `${llm.promptTokens ?? 0} in · ${llm.completionTokens ?? 0} out · ${llm.totalTokens ?? (llm.promptTokens ?? 0) + (llm.completionTokens ?? 0)} total`,
      });
    }
    if (llm.cost !== undefined) {
      rows.push({ label: "Cost", value: `$${llm.cost.toFixed(5)}` });
    }
    if (llm.modelParameters) {
      rows.push({
        label: "Model Parameters",
        value: (
          <pre className="span-details-json">
            {JSON.stringify(llm.modelParameters, null, 2)}
          </pre>
        ),
      });
    }
  }

  if (span.attributes) {
    rows.push({
      label: "Attributes",
      value: (
        <pre className="span-details-json">
          {JSON.stringify(span.attributes, null, 2)}
        </pre>
      ),
    });
  }

  return (
    <div className="span-details">
      <dl className="span-details-list">
        {rows.map((r, i) => (
          <div key={i} className="span-details-row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>

      {span.llm?.messages && span.llm.messages.length > 0 && (
        <div className="span-details-section">
          <div className="span-details-section-title">Input</div>
          {span.llm.messages.map((msg, i) => (
            <div key={i} className="span-message">
              <div className="span-message-role">{msg.role}</div>
              <div className="span-message-content">{msg.content}</div>
            </div>
          ))}
        </div>
      )}

      {span.llm?.output && (
        <div className="span-details-section">
          <div className="span-details-section-title">Output</div>
          <div className="span-message-content">{span.llm.output}</div>
        </div>
      )}
    </div>
  );
}

export default TraceView;
