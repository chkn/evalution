// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PromptID, Span, Trace, TraceLiveEvent } from "../../shared/types";
import { getTrace, subscribeTraceEvents } from "../api";
import { useAnnotations } from "../hooks/useAnnotations.ts";
import { ChatFlow } from "./trace/ChatFlow.tsx";
import { CombinedTimeline } from "./trace/CombinedTimeline.tsx";
import { CostTooltip } from "./trace/CostTooltip.tsx";
import {
  FlameTimeline,
  SpanKindPill,
  SpanStatusPill,
} from "./trace/FlameTimeline.tsx";
import {
  formatDuration,
  formatTimestamp,
  formatTimestampCompact,
  formatTokenCount,
} from "./trace/format.ts";
import {
  CalendarIcon,
  ConversationIcon,
  ModelIcon,
  MoreIcon,
  PlusIcon,
  PromptLinkIcon,
  SpansIcon,
  StopwatchIcon,
  TokensIcon,
  TreeCombinedIcon,
  TreeExpandedIcon,
} from "./trace/icons.tsx";
import { buildGroupedRows, buildRows, computeWindow } from "./trace/rows.ts";
import { SpanDetails } from "./trace/SpanDetails.tsx";
import { TraceAnnotations } from "./trace/TraceAnnotations.tsx";
import { computeCostBreakdown, summarizeUsage } from "./trace/usage.ts";
import { useAnchoredPopover } from "./use-anchored-popover";

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

function applyStreamEvent(prev: TraceState, event: TraceLiveEvent): TraceState {
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

type MainTab = "conversation" | "spans";

/**
 * `true` once the observed element is at least `minWidth` wide. Backs the
 * selected span's details layout: a side pane alongside the tabs when
 * there's room for one, a bottom pane below them otherwise.
 *
 * Uses a callback ref rather than `useRef` + `useEffect([])`: `TraceView`
 * renders a loading placeholder (no timeline div at all) until the trace
 * arrives, so the element this attaches to mounts on a later render, not the
 * first one — an effect keyed on `ref.current` would miss that.
 */
function useIsWide(minWidth: number) {
  const [isWide, setIsWide] = useState(false);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el) return;
      const observer = new ResizeObserver(([entry]) => {
        setIsWide(entry.contentRect.width >= minWidth);
      });
      observer.observe(el);
      observerRef.current = observer;
    },
    [minWidth],
  );

  return { ref, isWide };
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
  const [activeTab, setActiveTab] = useState<MainTab>("conversation");
  const [combined, setCombined] = useState(false);
  const { ref: bodyRef, isWide: showDetailsPane } = useIsWide(760);
  const listRef = useRef<HTMLDivElement>(null);
  const [showAnnotationForm, setShowAnnotationForm] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const {
    triggerRef: headerMenuTriggerRef,
    popoverRef: headerMenuRef,
    style: headerMenuStyle,
  } = useAnchoredPopover<HTMLButtonElement>({
    open: headerMenuOpen,
    onClose: () => setHeaderMenuOpen(false),
    matchTriggerWidth: false,
  });

  const {
    annotations,
    freshIds: freshAnnotationIds,
    clearFresh: clearFreshAnnotation,
    create: createAnnotation,
    remove: removeAnnotation,
    applyEvent: applyAnnotationEvent,
  } = useAnnotations(providerId, traceId);

  /**
   * Switching to the Spans tab scrolls the selected span's row so it lands
   * at the top (or as close to the top as the list can scroll) — the
   * reverse of `ChatFlow`'s own effect, which scrolls the chat to the
   * selected span whenever it (re)mounts, e.g. after switching to the
   * Conversation tab. Keyed only on `activeTab`, not `selectedSpanId`:
   * selecting a different row while the Spans tab is already active skips
   * this — it's already visible, so forcing it to the top would just be a
   * jarring jump.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally not reacting to selectedSpanId changes — see comment above.
  useEffect(() => {
    if (activeTab !== "spans" || !selectedSpanId) return;
    const el = listRef.current?.querySelector(
      `[data-span-id="${CSS.escape(selectedSpanId)}"]`,
    );
    const row = el?.closest(".trace-row") ?? el;
    row?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeTab]);

  useEffect(() => {
    const controller = new AbortController();

    // `getTrace` polls while the trace is still being created on the server, so
    // this may stay pending for a while; an `AbortError` on unmount is expected.
    getTrace(providerId, traceId, { signal: controller.signal })
      .then(data => {
        setState({ trace: data.trace, spans: data.spans });
      })
      .catch(err => {
        if (err.name !== "AbortError") setError(err.message);
      });

    const unsubscribe = subscribeTraceEvents(
      providerId,
      traceId,
      (event: TraceLiveEvent) => {
        if (event.type === "annotation") {
          applyAnnotationEvent(event);
        } else {
          setState(prev => applyStreamEvent(prev, event));
        }
      },
    );

    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [providerId, traceId, applyAnnotationEvent]);

  const rows = useMemo(() => buildRows(state.spans), [state.spans]);
  const groupedRows = useMemo(
    () => buildGroupedRows(state.spans),
    [state.spans],
  );
  const window = useMemo(
    () =>
      state.trace
        ? computeWindow(state.trace.startTime, state.trace.endTime, state.spans)
        : { start: 0, end: 1 },
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
  const usage = summarizeUsage(state.spans);
  const costBreakdown = computeCostBreakdown(usage);

  const rootSpan = state.spans.find(s => !s.parentId);
  const selectedSpan = state.spans.find(s => s.id === selectedSpanId);
  const rootPrompt = rootSpan?.prompt;
  const canOpenRootPrompt = !!(
    rootPrompt?.id &&
    rootPrompt?.providerId &&
    onOpenPrompt
  );
  const handleOpenRootPrompt = canOpenRootPrompt
    ? () =>
        onOpenPrompt!({
          id: rootPrompt!.id,
          providerId: rootPrompt!.providerId,
        })
    : undefined;

  const spanDetailsContent = selectedSpan && (
    <>
      <div className="trace-details-pane-header">
        <div className="trace-details-pane-title">
          {selectedSpan.kind !== "DEFAULT" && (
            <SpanKindPill kind={selectedSpan.kind} />
          )}
          <span className="trace-row-name">{selectedSpan.name}</span>
        </div>
        <div className="trace-details-pane-actions">
          <SpanStatusPill span={selectedSpan} />
          <button
            type="button"
            className="trace-details-pane-close"
            onClick={() => setSelectedSpanId(null)}
            aria-label="Close details"
          >
            ×
          </button>
        </div>
      </div>
      <code className="trace-details-pane-id">{selectedSpan.id}</code>
      <SpanDetails
        span={selectedSpan}
        annotations={annotations}
        freshIds={freshAnnotationIds}
        onClearFresh={clearFreshAnnotation}
        onCreateAnnotation={createAnnotation}
        onDeleteAnnotation={removeAnnotation}
      />
    </>
  );

  const headerMenu =
    headerMenuOpen &&
    createPortal(
      <div
        className="trace-header-menu"
        ref={headerMenuRef}
        style={headerMenuStyle}
      >
        {canOpenRootPrompt && (
          <button
            type="button"
            className="trace-header-menu-item"
            onClick={() => {
              handleOpenRootPrompt!();
              setHeaderMenuOpen(false);
            }}
          >
            <span className="trace-header-menu-item-icon">
              <PromptLinkIcon />
            </span>
            <span className="trace-header-menu-item-label">Open prompt</span>
          </button>
        )}
        <button
          type="button"
          className="trace-header-menu-item"
          onClick={() => {
            setShowAnnotationForm(true);
            setHeaderMenuOpen(false);
          }}
        >
          <span className="trace-header-menu-item-icon">
            <PlusIcon />
          </span>
          <span className="trace-header-menu-item-label">Add annotation</span>
        </button>
      </div>,
      document.body,
    );

  return (
    <div className="trace-view">
      <div className="trace-view-header">
        <div className="trace-view-header-row">
          <div className="trace-view-title">
            <span
              className={`trace-status-dot trace-status-${state.trace.status}`}
            />
            <span className="trace-view-name">{state.trace.name}</span>
          </div>
          <div className="trace-view-header-actions">
            <div className="trace-view-header-actions-full">
              {canOpenRootPrompt && (
                <button
                  type="button"
                  className="trace-view-prompt-btn"
                  onClick={handleOpenRootPrompt}
                  title="Open prompt"
                >
                  <PromptLinkIcon />
                  Open prompt
                </button>
              )}
              <button
                type="button"
                className="trace-annotations-add"
                onClick={() => setShowAnnotationForm(true)}
              >
                + Add annotation
              </button>
            </div>
            <button
              type="button"
              ref={headerMenuTriggerRef}
              className="trace-view-header-menu-trigger"
              onClick={() => setHeaderMenuOpen(o => !o)}
              title="More actions"
              aria-label="More actions"
            >
              <MoreIcon />
            </button>
          </div>
        </div>
        <div className="trace-view-meta">
          <span className="trace-view-meta-item">
            <CalendarIcon />
            <span className="trace-view-date-full">
              {formatTimestamp(state.trace.startTime)}
            </span>
            <span className="trace-view-date-compact">
              {formatTimestampCompact(state.trace.startTime)}
            </span>
          </span>
          <span className="trace-view-meta-item">
            <SpansIcon />
            {state.spans.length} span{state.spans.length === 1 ? "" : "s"}
          </span>
          <span className="trace-view-meta-item">
            <StopwatchIcon />
            {formatDuration(totalDuration)}
          </span>
          {usage.promptTokens !== undefined && (
            <span className="trace-view-meta-item trace-view-meta-tokens">
              <TokensIcon />
              {formatTokenCount(usage.promptTokens)} in ·{" "}
              {formatTokenCount(usage.completionTokens ?? 0)} out
            </span>
          )}
          {usage.model && (
            <span className="trace-view-meta-item trace-view-meta-model">
              <ModelIcon />
              {usage.model}
            </span>
          )}
          {costBreakdown && <CostTooltip breakdown={costBreakdown} />}
        </div>
      </div>
      {headerMenu}

      <TraceAnnotations
        annotations={annotations}
        freshIds={freshAnnotationIds}
        onClearFresh={clearFreshAnnotation}
        onCreate={createAnnotation}
        onDelete={removeAnnotation}
        showForm={showAnnotationForm}
        onCloseForm={() => setShowAnnotationForm(false)}
      />

      <div className="trace-view-body" ref={bodyRef}>
        <div className="trace-view-main-column">
          <div className="trace-view-tabs">
            <div className="trace-view-tab-list">
              <button
                type="button"
                className={`trace-view-tab${activeTab === "conversation" ? " trace-view-tab-active" : ""}`}
                onClick={() => setActiveTab("conversation")}
              >
                <ConversationIcon />
                Conversation
              </button>
              <button
                type="button"
                className={`trace-view-tab${activeTab === "spans" ? " trace-view-tab-active" : ""}`}
                onClick={() => setActiveTab("spans")}
              >
                <TreeExpandedIcon />
                Spans
              </button>
            </div>
            {activeTab === "spans" && (
              <button
                type="button"
                className={`trace-spans-combined-toggle${combined ? " trace-spans-combined-toggle-active" : ""}`}
                onClick={() => setCombined(c => !c)}
                title="Group repeated spans"
                aria-label="Group repeated spans"
                aria-pressed={combined}
              >
                <TreeCombinedIcon />
              </button>
            )}
          </div>

          {activeTab === "spans" ? (
            <div className="trace-timeline-list" ref={listRef}>
              {combined ? (
                <CombinedTimeline
                  groups={groupedRows}
                  window={window}
                  selectedSpanId={selectedSpanId}
                  onSelectSpan={setSelectedSpanId}
                />
              ) : (
                <FlameTimeline
                  rows={rows}
                  window={window}
                  selectedSpanId={selectedSpanId}
                  onSelectSpan={setSelectedSpanId}
                  annotations={annotations}
                />
              )}
            </div>
          ) : (
            <div className="trace-chat-region">
              <ChatFlow
                rows={rows}
                selectedSpanId={selectedSpanId}
                onSelectSpan={setSelectedSpanId}
              />
            </div>
          )}

          {!showDetailsPane && spanDetailsContent && (
            <div className="trace-details-bottom-pane">
              {spanDetailsContent}
            </div>
          )}
        </div>

        {showDetailsPane && spanDetailsContent && (
          <div className="trace-details-pane">{spanDetailsContent}</div>
        )}
      </div>
    </div>
  );
}

export default TraceView;
