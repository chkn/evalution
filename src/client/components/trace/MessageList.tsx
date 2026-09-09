// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Renders an LLM span's `messages`, markdown-formatted, with image content
 * parts rendered as actual images (validated via `./imageSrc.ts`) rather than
 * dropped or shown as a placeholder — see `specs/trace-workshopping.md` §A.5/§D.
 */

import type { SpanContentPart, SpanMessage } from "../../../shared/types";
import { toSafeImageSrc } from "./imageSrc.ts";
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

function MessageContent({ content }: { content: string | SpanContentPart[] }) {
  if (typeof content === "string") return <Markdown>{content}</Markdown>;
  return (
    <>
      {content.map((part, i) =>
        part.type === "text" ? (
          <Markdown key={i}>{part.text}</Markdown>
        ) : (
          <MessageImage key={i} part={part} />
        ),
      )}
    </>
  );
}

export function MessageList({ messages }: { messages: SpanMessage[] }) {
  return (
    <div className="message-list">
      {messages.map((msg, i) => (
        <div key={i} className={`message message-role-${msg.role}`}>
          <div className="message-role">{msg.role}</div>
          <div className="message-content">
            <MessageContent content={msg.content} />
          </div>
        </div>
      ))}
    </div>
  );
}
