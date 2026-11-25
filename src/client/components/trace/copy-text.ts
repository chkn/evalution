// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { SpanContentPart } from "../../../shared/types";

/**
 * A span value as text to copy: a string as itself, anything else as
 * pretty-printed JSON.
 */
export function copyText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * A message's content as text to copy: its text parts as written, a tool
 * call's arguments and a tool result's output as JSON, one part to a
 * paragraph. Images, and reasoning (collapsed behind its own toggle), are
 * left out.
 */
export function messageText(content: string | SpanContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap(part => {
      switch (part.type) {
        case "text":
          return [part.text];
        case "tool-call":
          return [copyText(part.input)];
        case "tool-result":
          return [copyText(part.output)];
        default:
          return [];
      }
    })
    .join("\n\n");
}
