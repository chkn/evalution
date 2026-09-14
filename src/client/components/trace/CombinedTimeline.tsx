// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The "Combined" tree view: one row per unique span name, with every
 * instance's extent plotted as its own segment along that row's bar — so a
 * step called many times (a retry loop, a tool called per item) collapses to
 * a single row instead of repeating once per call. Clicking a segment shows
 * that instance's details, same as a row in {@link FlameTimeline}.
 */

import { SpanErrorIcon, SpanKindPill } from "./FlameTimeline.tsx";
import { formatDuration } from "./format.ts";
import { barGeometry, type GroupedRow, spanDuration } from "./rows.ts";

export interface CombinedTimelineProps {
  groups: GroupedRow[];
  window: { start: number; end: number };
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string | null) => void;
}

export function CombinedTimeline({
  groups,
  window,
  selectedSpanId,
  onSelectSpan,
}: CombinedTimelineProps) {
  return (
    <div className="trace-waterfall">
      {groups.map(group => {
        const groupSelected = group.spans.some(s => s.id === selectedSpanId);
        const hasError = group.spans.some(s => s.status === "error");
        const stillRunning = group.spans.some(s => s.endTime === undefined);
        const totalSpanDuration = group.spans.reduce(
          (sum, s) => sum + (spanDuration(s) ?? 0),
          0,
        );

        return (
          <div
            key={group.name}
            className={`trace-row${groupSelected ? " trace-row-selected" : ""}${hasError ? " trace-row-error" : ""}`}
          >
            <div
              className="trace-row-main"
              onClick={() =>
                onSelectSpan(groupSelected ? null : group.spans[0].id)
              }
            >
              <div className="trace-row-label">
                <SpanErrorIcon visible={hasError} />
                {group.kind !== "DEFAULT" && <SpanKindPill kind={group.kind} />}
                <span className="trace-row-name">{group.name}</span>
                {group.spans.length > 1 && (
                  <span
                    className="trace-row-count-badge"
                    title={`Called ${group.spans.length} times`}
                  >
                    ×{group.spans.length}
                  </span>
                )}
              </div>
              <div className="trace-row-duration">
                {formatDuration(totalSpanDuration)}
                {stillRunning ? " …" : ""}
              </div>
              <div className="trace-row-bar-track">
                {group.spans.map(span => {
                  const running = span.endTime === undefined;
                  const duration = spanDuration(span);

                  return (
                    <button
                      type="button"
                      key={span.id}
                      data-span-id={span.id}
                      className={`trace-row-bar trace-combined-bar-segment trace-row-bar-${span.kind}${running ? " trace-row-bar-running" : ""}${span.id === selectedSpanId ? " trace-combined-bar-segment-selected" : ""}`}
                      style={barGeometry(span, window)}
                      title={`${duration !== undefined ? formatDuration(duration) : "running…"}${span.status === "error" ? " · error" : ""}`}
                      onClick={e => {
                        e.stopPropagation();
                        onSelectSpan(
                          span.id === selectedSpanId ? null : span.id,
                        );
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
