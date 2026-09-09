// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { PromptID, Span, Trace, TraceLiveEvent } from "../../shared/types";
import { getTrace, subscribeTraceEvents } from "../api";
import { useAnnotations } from "../hooks/useAnnotations.ts";
import { ChatFlow } from "./trace/ChatFlow.tsx";
import { FlameTimeline } from "./trace/FlameTimeline.tsx";
import {
  formatDuration,
  formatTimestamp,
  formatTimestampCompact,
} from "./trace/format.ts";
import {
  CalendarIcon,
  MoreIcon,
  PlusIcon,
  PromptLinkIcon,
  SpansIcon,
  StopwatchIcon,
} from "./trace/icons.tsx";
import { buildRows, computeWindow } from "./trace/rows.ts";
import { toSpanViewModel } from "./trace/spanViewModel.ts";
import { TraceAnnotations } from "./trace/TraceAnnotations.tsx";
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

type ViewTab = "tree" | "chat";

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
  const [tab, setTab] = useState<ViewTab>("tree");
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

  const spanViewModels = useMemo(
    () => state.spans.map(toSpanViewModel),
    [state.spans],
  );
  const rows = useMemo(() => buildRows(spanViewModels), [spanViewModels]);
  const window = useMemo(
    () =>
      state.trace
        ? computeWindow(
            state.trace.startTime,
            state.trace.endTime,
            spanViewModels,
          )
        : { start: 0, end: 1 },
    [state.trace, spanViewModels],
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

  const rootSpan = spanViewModels.find(s => !s.parentId);
  const canOpenRootPrompt = !!(
    rootSpan?.promptId &&
    rootSpan?.promptProviderId &&
    onOpenPrompt
  );
  const handleOpenRootPrompt = canOpenRootPrompt
    ? () =>
        onOpenPrompt!({
          id: rootSpan!.promptId!,
          providerId: rootSpan!.promptProviderId,
        })
    : undefined;

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

      <div className="trace-view-tabs">
        <button
          type="button"
          className={`trace-view-tab${tab === "tree" ? " trace-view-tab-active" : ""}`}
          onClick={() => setTab("tree")}
        >
          Tree
        </button>
        <button
          type="button"
          className={`trace-view-tab${tab === "chat" ? " trace-view-tab-active" : ""}`}
          onClick={() => setTab("chat")}
        >
          Chat
        </button>
      </div>

      {tab === "tree" ? (
        <FlameTimeline
          rows={rows}
          window={window}
          selectedSpanId={selectedSpanId}
          onSelectSpan={setSelectedSpanId}
          onOpenPrompt={onOpenPrompt}
          hidePromptButtonSpanId={canOpenRootPrompt ? rootSpan!.id : undefined}
          annotations={annotations}
          freshAnnotationIds={freshAnnotationIds}
          onClearFreshAnnotation={clearFreshAnnotation}
          onCreateAnnotation={createAnnotation}
          onDeleteAnnotation={removeAnnotation}
        />
      ) : (
        <ChatFlow rows={rows} />
      )}
    </div>
  );
}

export default TraceView;
