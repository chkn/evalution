// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Linear conversation view: walks the span tree and renders each `LLM`
 * span's messages/output and each `TOOL` span's call as one continuous
 * thread, instead of having to expand each row in the flame view one at a
 * time.
 *
 * Scoped down from Workshop's `ChatFlow.tsx`: that version is built around
 * *live token-delta* events from Workshop's own websocket protocol
 * (streaming partial text/tool-args as an LLM call is still in flight, plus
 * sub-agent focus popovers). evalution's SSE only ever carries whole-span
 * `span-start`/`span-end` events — there is no token-level delta stream to
 * render — so this renders the completed conversation from span data; a
 * still-running span just shows a "running" indicator until its `span-end`
 * arrives. See `specs/trace-workshopping.md` §D.
 */

import { useEffect, useRef, useState } from "react";
import type { SpanMessage } from "../../../shared/types";
import { formatDuration } from "./format.ts";
import { ChevronIcon, StopwatchIcon, WrenchIcon } from "./icons.tsx";
import { JsonView } from "./JsonView.tsx";
import { MessageList } from "./MessageList.tsx";
import type { Row } from "./rows.ts";
import { newMessagesByTurn, spanDuration } from "./rows.ts";

/**
 * Renders one `LLM` span's turn as bare chat bubbles (no surrounding card).
 * `newMessages` is the caller-computed suffix of `span.llm.messages` that
 * hasn't already been rendered by an earlier turn — see {@link ChatFlow}. Tool
 * (role `"tool"`) messages are dropped here — the adjacent `TOOL` span's
 * card already shows that call's arguments/result.
 *
 * Clicking anywhere in the turn selects its span, so the flame/combined
 * timeline above highlights (and shows details for) the same span — see
 * `TraceView`. `selected` mirrors that back the other way, highlighting the
 * turn when its span is selected from the timeline.
 */
function ChatLLMBlock({
  row,
  newMessages,
  selected,
  onSelect,
}: {
  row: Row;
  newMessages: SpanMessage[];
  selected: boolean;
  onSelect: () => void;
}) {
  const { span } = row;
  const visibleMessages = newMessages.filter(m => m.role !== "tool");
  return (
    <div
      className={`chat-turn${span.status === "error" ? " chat-turn-error" : ""}${selected ? " chat-turn-selected" : ""}`}
      data-span-id={span.id}
      onClick={onSelect}
    >
      {visibleMessages.length > 0 && (
        <MessageList messages={visibleMessages} variant="bubble" />
      )}
      {span.llm?.output && (
        <MessageList
          messages={[{ role: "assistant", content: span.llm.output }]}
          variant="bubble"
        />
      )}
      {span.errorMessage && (
        <pre className="span-details-error">{span.errorMessage}</pre>
      )}
    </div>
  );
}

/**
 * Renders one `TOOL` span's call as a collapsible card. Collapsed by
 * default; the chevron toggles it open to reveal the call's arguments,
 * result, and error, if any — the same data `SpanDetails` shows in the side
 * pane, but inline so it doesn't require opening one. The toggle stops
 * propagation so it doesn't also select the span, unlike a click anywhere
 * else on the card.
 */
function ChatToolBlock({
  row,
  selected,
  onSelect,
}: {
  row: Row;
  selected: boolean;
  onSelect: () => void;
}) {
  const { span } = row;
  const { tool } = span;
  const running = span.endTime === undefined;
  const duration = spanDuration(span);
  const [expanded, setExpanded] = useState(false);
  const hasDetails =
    tool?.input !== undefined ||
    tool?.output !== undefined ||
    !!span.errorMessage;

  return (
    <div
      className={`chat-block chat-block-tool${span.status === "error" ? " chat-block-error" : ""}${selected ? " chat-block-selected" : ""}`}
      data-span-id={span.id}
      onClick={onSelect}
    >
      <div className="chat-block-header">
        <span className="chat-block-tool-icon" aria-hidden>
          <WrenchIcon />
        </span>
        <span className="chat-block-label">{tool?.toolName ?? span.name}</span>
        {duration !== undefined && (
          <span className="chat-block-duration">
            <StopwatchIcon />
            {formatDuration(duration)}
          </span>
        )}
        {running && <span className="chat-block-running">running…</span>}
        {hasDetails && (
          <button
            type="button"
            className="chat-block-expand-toggle"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={e => {
              e.stopPropagation();
              setExpanded(x => !x);
            }}
          >
            <ChevronIcon open={expanded} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="chat-block-tool-section">
          {tool?.input !== undefined && (
            <div className="span-details-row">
              <div className="span-details-row-label">Arguments</div>
              <div className="span-details-row-value">
                <JsonView data={tool.input} />
              </div>
            </div>
          )}
          {tool?.output !== undefined && (
            <div className="span-details-row">
              <div className="span-details-row-label">Result</div>
              <div className="span-details-row-value">
                <JsonView data={tool.output} />
              </div>
            </div>
          )}
          {span.errorMessage && (
            <div className="span-details-row">
              <div className="span-details-row-label">Error</div>
              <pre className="span-details-error">{span.errorMessage}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders `rows` (already parent-sorted by `buildRows`) as a linear thread.
 * `AGENT`/`EMBEDDING`/`DEFAULT` spans are structural — their `LLM`/`TOOL`
 * descendants are what actually render a chat block.
 *
 * Each `LLM` span's `llm.messages` is the *full* conversation sent to the model,
 * so a later turn's `messages` re-includes everything already shown by
 * earlier turns (system prompt, prior user/assistant turns, prior tool
 * results, prior `output`). To avoid repeating those, each turn only renders
 * the suffix of `messages` past the longest prefix already rendered so far
 * — see `newMessagesByTurn`.
 *
 * `selectedSpanId`/`onSelectSpan` mirror the flame/combined timeline's
 * selection (see `TraceView`): selecting a span here calls back up to select
 * it there, and selecting it there scrolls the matching block into view and
 * highlights it here.
 */
export function ChatFlow({
  rows,
  selectedSpanId,
  onSelectSpan,
}: {
  rows: Row[];
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const blocks = rows.filter(
    r => r.span.kind === "LLM" || r.span.kind === "TOOL",
  );

  useEffect(() => {
    if (!selectedSpanId) return;
    const el = containerRef.current?.querySelector(
      `[data-span-id="${CSS.escape(selectedSpanId)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedSpanId]);

  if (blocks.length === 0) {
    return (
      <div className="chat-flow-empty">No messages or tool calls yet.</div>
    );
  }
  const newMessages = newMessagesByTurn(rows);
  return (
    <div className="chat-flow" ref={containerRef}>
      {blocks.map(row =>
        row.span.kind === "LLM" ? (
          <ChatLLMBlock
            key={row.span.id}
            row={row}
            newMessages={newMessages.get(row.span.id) ?? []}
            selected={row.span.id === selectedSpanId}
            onSelect={() => onSelectSpan(row.span.id)}
          />
        ) : (
          <ChatToolBlock
            key={row.span.id}
            row={row}
            selected={row.span.id === selectedSpanId}
            onSelect={() => onSelectSpan(row.span.id)}
          />
        ),
      )}
    </div>
  );
}
