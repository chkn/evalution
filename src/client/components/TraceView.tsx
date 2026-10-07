// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentInfo } from "../../shared/agent";
import type {
  NormalizedPrompt,
  PromptID,
  Span,
  Trace,
  TraceLiveEvent,
} from "../../shared/types";
import { deleteTrace, getTrace, subscribeTraceEvents } from "../api";
import { useAnnotations } from "../hooks/useAnnotations.ts";
import { AddToDatasetMenu, isInAddToDatasetMenu } from "./AddToDatasetMenu";
import { AskAgentButton, AskAgentMenuItems } from "./AskAgentButton";
import { DetailsPane, DetailsPaneHeader, useIsWide } from "./DetailsPane";
import { fieldsForTrace, fromTrace, hasRecordedInputs } from "./named-inputs";
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
  DatasetsIcon,
  ModelIcon,
  MoreIcon,
  PlusIcon,
  PromptLinkIcon,
  SpansIcon,
  StopwatchIcon,
  TokensIcon,
  TrashIcon,
  TreeCombinedIcon,
  TreeExpandedIcon,
} from "./trace/icons.tsx";
import { buildGroupedRows, buildRows, computeWindow } from "./trace/rows.ts";
import { SpanDetails } from "./trace/SpanDetails.tsx";
import { TraceAnnotations } from "./trace/TraceAnnotations.tsx";
import { TraceCheckResults } from "./trace/TraceCheckResults.tsx";
import { computeCostBreakdown, summarizeUsage } from "./trace/usage.ts";
import { useAnchoredPopover } from "./use-anchored-popover";

interface Props {
  providerId: string;
  traceId: string;
  /** Span to select and scroll to on first render. */
  initialSpanId?: string;
  /**
   * Called when the user asks to open a linked prompt in a split pane. Gets
   * the root span's whole recorded prompt — inputs included — so the panel
   * can be filled from it.
   */
  onOpenPrompt?: (prompt: PromptID) => void;
  /**
   * Looks up the prompt a (resolved) prompt reference names, if it's loaded.
   * Supplies names and types a production trace doesn't record, and the
   * schema a new dataset gets.
   */
  findPrompt?: (prompt: PromptID) => NormalizedPrompt | undefined;
  /** Called after the user deletes this trace, so its tab can be closed. */
  onDeleted?: () => void;
  /** Bumped on eval changes, so the trace's check results stay current. */
  evalVersion?: number;
  /** Coding agents the "Ask" button offers. */
  agents?: readonly AgentInfo[];
  /**
   * Launches a coding agent about this trace. Without it (or without
   * `agents`), there's no "Ask" button.
   */
  onAskAgent?: (agent: AgentInfo) => void;
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

function TraceView({
  providerId,
  traceId,
  initialSpanId,
  onOpenPrompt,
  findPrompt,
  onDeleted,
  evalVersion,
  agents = [],
  onAskAgent,
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
    // The add-to-dataset menu it contains is its own portal.
    extraContains: isInAddToDatasetMenu,
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

  const handleDelete = async () => {
    if (
      !globalThis.confirm(
        `Delete “${state.trace!.name}” and its ${state.spans.length} span${state.spans.length === 1 ? "" : "s"}? This can't be undone.`,
      )
    )
      return;
    try {
      await deleteTrace(providerId, traceId);
      onDeleted?.();
    } catch (err: any) {
      globalThis.alert(`Could not delete the trace: ${err.message}`);
    }
  };

  // "Add to dataset", fed by the root span's recorded inputs — or, for a
  // production trace, its raw arguments typed by the current prompt.
  const currentPrompt =
    rootPrompt?.providerId && findPrompt ? findPrompt(rootPrompt) : undefined;
  const traceInputs =
    rootPrompt && hasRecordedInputs(rootPrompt)
      ? fromTrace(rootPrompt, currentPrompt)
      : [];
  const addToDatasetProps =
    rootPrompt &&
    traceInputs.length > 0 &&
    ({
      inputs: traceInputs,
      newDatasetFields: fieldsForTrace(rootPrompt, currentPrompt, traceInputs),
      prompt: currentPrompt?.providerId
        ? {
            link: {
              id: currentPrompt.globalId ?? currentPrompt.id,
              providerId: currentPrompt.providerId,
            },
            openable: {
              id: currentPrompt.id,
              providerId: currentPrompt.providerId,
            },
          }
        : undefined,
      source: { kind: "trace", traceId, traceProviderId: providerId },
    } satisfies Omit<
      React.ComponentProps<typeof AddToDatasetMenu>,
      "children"
    >);

  const spanDetailsContent = selectedSpan && (
    <>
      <DetailsPaneHeader
        title={
          <>
            {selectedSpan.kind !== "DEFAULT" && (
              <SpanKindPill kind={selectedSpan.kind} />
            )}
            <span className="trace-row-name">{selectedSpan.name}</span>
          </>
        }
        actions={<SpanStatusPill span={selectedSpan} />}
        id={selectedSpan.id}
        onClose={() => setSelectedSpanId(null)}
      />
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
        {onAskAgent && (
          <AskAgentMenuItems
            // Only those that can run: the button's own menu is where the
            // rest, and "Other", are offered.
            agents={agents.filter(agent => !agent.disabledReason)}
            onAsk={agent => {
              setHeaderMenuOpen(false);
              onAskAgent(agent);
            }}
          />
        )}
        {addToDatasetProps && (
          <AddToDatasetMenu
            {...addToDatasetProps}
            className="trace-header-menu-item"
          >
            <span className="trace-header-menu-item-icon">
              <DatasetsIcon />
            </span>
            <span className="trace-header-menu-item-label">Add to dataset</span>
          </AddToDatasetMenu>
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
        {onDeleted && (
          <button
            type="button"
            className="trace-header-menu-item trace-menu-delete"
            onClick={() => {
              setHeaderMenuOpen(false);
              void handleDelete();
            }}
          >
            <span className="trace-header-menu-item-icon">
              <TrashIcon />
            </span>
            <span className="trace-header-menu-item-label">Delete trace</span>
          </button>
        )}
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
              {onAskAgent && (
                <AskAgentButton agents={agents} onAsk={onAskAgent} />
              )}
              {addToDatasetProps && (
                <AddToDatasetMenu
                  {...addToDatasetProps}
                  className="trace-view-prompt-btn"
                />
              )}
              <button
                type="button"
                className="trace-annotations-add"
                onClick={() => setShowAnnotationForm(true)}
              >
                + Add annotation
              </button>
              {onDeleted && (
                <button
                  type="button"
                  className="trace-view-prompt-btn trace-view-delete-btn"
                  onClick={() => void handleDelete()}
                  title="Delete trace"
                  aria-label="Delete trace"
                >
                  <TrashIcon />
                </button>
              )}
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
          {canOpenRootPrompt && (
            <button
              type="button"
              className="trace-view-meta-item trace-view-prompt-link"
              onClick={() => onOpenPrompt!(rootPrompt!)}
              title="Open prompt with inputs filled from trace"
            >
              <PromptLinkIcon />
              <span className="trace-view-prompt-link-name">
                {currentPrompt?.name ?? rootPrompt!.id}
              </span>
              ↗
            </button>
          )}
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
      <TraceCheckResults
        providerId={providerId}
        traceId={traceId}
        version={evalVersion}
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
            <DetailsPane placement="bottom">{spanDetailsContent}</DetailsPane>
          )}
        </div>

        {showDetailsPane && spanDetailsContent && (
          <DetailsPane placement="side">{spanDetailsContent}</DetailsPane>
        )}
      </div>
    </div>
  );
}

export default TraceView;
