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

import type { SpanMessage } from "../../../shared/types";
import { JsonView } from "./JsonView.tsx";
import { MessageList } from "./MessageList.tsx";
import type { Row } from "./rows.ts";
import { newMessagesByTurn } from "./rows.ts";

/**
 * Renders one `LLM` span's turn as bare chat bubbles (no surrounding card).
 * `newMessages` is the caller-computed suffix of `span.messages` that hasn't
 * already been rendered by an earlier turn — see {@link ChatFlow}. Tool
 * (role `"tool"`) messages are dropped here — the adjacent `TOOL` span's
 * card already shows that call's arguments/result.
 */
function ChatLLMBlock({
  row,
  newMessages,
}: {
  row: Row;
  newMessages: SpanMessage[];
}) {
  const { span } = row;
  const visibleMessages = newMessages.filter(m => m.role !== "tool");
  return (
    <div
      className={`chat-turn${span.status === "error" ? " chat-turn-error" : ""}`}
    >
      {visibleMessages.length > 0 && (
        <MessageList messages={visibleMessages} variant="bubble" />
      )}
      {span.output && (
        <MessageList
          messages={[{ role: "assistant", content: span.output }]}
          variant="bubble"
        />
      )}
      {span.errorMessage && (
        <pre className="span-details-error">{span.errorMessage}</pre>
      )}
    </div>
  );
}

function ChatToolBlock({ row }: { row: Row }) {
  const { span } = row;
  const running = span.endMs === undefined;
  return (
    <div
      className={`chat-block chat-block-tool${span.status === "error" ? " chat-block-error" : ""}`}
    >
      <div className="chat-block-header">
        <span className="chat-block-tool-icon" aria-hidden>
          ⚙
        </span>
        <span className="chat-block-label">{span.toolName ?? span.name}</span>
        {running && <span className="chat-block-running">running…</span>}
      </div>
      {span.toolArgs !== undefined && (
        <div className="chat-block-tool-section">
          <div className="span-details-section-title">Arguments</div>
          <JsonView data={span.toolArgs} maxExpand={1} />
        </div>
      )}
      {span.toolResult !== undefined && (
        <div className="chat-block-tool-section">
          <div className="span-details-section-title">Result</div>
          <JsonView data={span.toolResult} maxExpand={1} />
        </div>
      )}
      {span.errorMessage && (
        <pre className="span-details-error">{span.errorMessage}</pre>
      )}
    </div>
  );
}

/**
 * Renders `rows` (already parent-sorted by `buildRows`) as a linear thread.
 * `AGENT`/`EMBEDDING`/`DEFAULT` spans are structural — their `LLM`/`TOOL`
 * descendants are what actually render a chat block.
 *
 * Each `LLM` span's `messages` is the *full* conversation sent to the model,
 * so a later turn's `messages` re-includes everything already shown by
 * earlier turns (system prompt, prior user/assistant turns, prior tool
 * results, prior `output`). To avoid repeating those, each turn only renders
 * the suffix of `messages` past the longest prefix already rendered so far
 * — see `newMessagesByTurn`.
 */
export function ChatFlow({ rows }: { rows: Row[] }) {
  const blocks = rows.filter(
    r => r.span.spanType === "LLM" || r.span.spanType === "TOOL",
  );
  if (blocks.length === 0) {
    return (
      <div className="chat-flow-empty">No messages or tool calls yet.</div>
    );
  }
  const newMessages = newMessagesByTurn(rows);
  return (
    <div className="chat-flow">
      {blocks.map(row =>
        row.span.spanType === "LLM" ? (
          <ChatLLMBlock
            key={row.span.id}
            row={row}
            newMessages={newMessages.get(row.span.id) ?? []}
          />
        ) : (
          <ChatToolBlock key={row.span.id} row={row} />
        ),
      )}
    </div>
  );
}
