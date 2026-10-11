// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Renders an LLM span's `messages`, markdown-formatted, with image content
 * parts rendered as actual images (validated via `./imageSrc.ts`) rather than
 * dropped or shown as a placeholder — see `specs/trace-workshopping.md` §A.5/§D.
 * Tool calls and tool results render as their tool's name over their JSON.
 */

import type { SpanContentPart, SpanMessage } from "../../../shared/types";
import { toSafeImageSrc } from "./imageSrc.ts";
import { JsonView } from "./JsonView.tsx";
import { Markdown } from "./Markdown.tsx";

function MessageImage({
  part,
}: {
  part: Extract<SpanContentPart, { type: "image" }>;
}) {
  const src = toSafeImageSrc(part.image, part.mediaType);
  if (!src) {
    return <div className="message-image-unavailable">[image unavailable]</div>;
  }
  return <img className="message-image" src={src} alt="" />;
}

function MessageToolPart({
  part,
}: {
  part: Extract<SpanContentPart, { type: "tool-call" | "tool-result" }>;
}) {
  const call = part.type === "tool-call";
  const error = !call && part.isError;
  return (
    <div
      className={`message-tool-part message-${part.type}${error ? " message-tool-part-error" : ""}`}
    >
      <div className="message-tool-part-label">
        {call ? "Call" : error ? "Error from" : "Result from"}{" "}
        <code>{part.toolName}</code>
      </div>
      <JsonView data={call ? part.input : part.output} />
    </div>
  );
}

function MessagePart({ part }: { part: SpanContentPart }) {
  switch (part.type) {
    case "text":
      return <Markdown>{part.text}</Markdown>;
    case "image":
      return <MessageImage part={part} />;
    case "tool-call":
    case "tool-result":
      return <MessageToolPart part={part} />;
  }
}

function MessageContent({ content }: { content: string | SpanContentPart[] }) {
  if (typeof content === "string") return <Markdown>{content}</Markdown>;
  return (
    <>
      {content.map((part, i) => (
        <MessagePart key={i} part={part} />
      ))}
    </>
  );
}

export function MessageList({
  messages,
  variant = "card",
}: {
  messages: SpanMessage[];
  /** `"card"` (default) for the span-details panel; `"bubble"` for chat bubbles in {@link ChatFlow}. */
  variant?: "card" | "bubble";
}) {
  const rootClass =
    variant === "bubble" ? "message-list-bubble" : "message-list";
  const itemClass = variant === "bubble" ? "chat-bubble" : "message";
  const roleClass = variant === "bubble" ? "chat-bubble-role" : "message-role";
  const contentClass =
    variant === "bubble" ? "chat-bubble-content" : "message-content";
  return (
    <div className={rootClass}>
      {messages.map((msg, i) => (
        <div key={i} className={`${itemClass} ${itemClass}-role-${msg.role}`}>
          <div className={roleClass}>{msg.role}</div>
          <div className={contentClass}>
            <MessageContent content={msg.content} />
          </div>
        </div>
      ))}
    </div>
  );
}
