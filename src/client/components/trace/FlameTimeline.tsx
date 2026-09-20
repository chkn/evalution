// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The trace waterfall: a flame-graph-style timeline merged with the span
 * tree (each row is both a timing bar and a tree node with depth indentation
 * + disclosure toggle)
 */

import type { Annotation, SpanKind } from "../../../shared/types";
import { formatDuration, spanDisplayStatus, statusGlyph } from "./format.ts";
import { barGeometry, type Row, spanDuration } from "./rows.ts";

export function SpanKindPill({ kind }: { kind: SpanKind }) {
  return <span className={`span-kind-pill span-kind-${kind}`}>{kind}</span>;
}

/** A span's status as a token — `✓ ok`, `✕ error`, `● running`. Renders nothing for an ended span with no status. */
export function SpanStatusPill({
  span,
}: {
  span: { status?: string; endTime?: number };
}) {
  const status = spanDisplayStatus(span);
  if (!status) return null;
  return (
    <span className={`span-status-pill span-status-${status}`}>
      {statusGlyph(status)} {status}
    </span>
  );
}

export function SpanErrorIcon({ visible }: { visible: boolean }) {
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

export interface FlameTimelineProps {
  rows: Row[];
  window: { start: number; end: number };
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string | null) => void;
  annotations: Annotation[];
}

export function FlameTimeline({
  rows,
  window,
  selectedSpanId,
  onSelectSpan,
  annotations,
}: FlameTimelineProps) {
  return (
    <div className="trace-waterfall">
      {rows.map(row => {
        const span = row.span;
        const isSelected = span.id === selectedSpanId;
        const running = span.endTime === undefined;
        const duration = spanDuration(span);

        const hasError = span.status === "error";
        const spanAnnotationCount = annotations.filter(
          a => a.spanId === span.id,
        ).length;

        return (
          <div
            key={span.id}
            data-span-id={span.id}
            className={`trace-row${isSelected ? " trace-row-selected" : ""}${hasError ? " trace-row-error" : ""}`}
          >
            <div
              className="trace-row-main"
              onClick={() => onSelectSpan(isSelected ? null : span.id)}
            >
              <div
                className="trace-row-label"
                style={{ paddingLeft: row.depth * 16 }}
              >
                <SpanErrorIcon visible={hasError} />
                {span.kind !== "DEFAULT" && <SpanKindPill kind={span.kind} />}
                <span className="trace-row-name">{span.name}</span>
                {spanAnnotationCount > 0 && (
                  <span
                    className="trace-row-annotation-count"
                    title={`${spanAnnotationCount} annotation(s)`}
                  >
                    {spanAnnotationCount}
                  </span>
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
                  style={barGeometry(span, window)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
