// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropValue } from "ts-proppy";
import type { SpanKind } from "./types.ts";

export function otelOperationToSpanKind(operationName: any): SpanKind {
  switch (operationName) {
    case "chat":
    case "response":
    case "text_completion":
    case "generate_content":
      return "LLM";
    case "execute_tool":
      return "TOOL";
    case "create_agent":
    case "invoke_agent":
      return "AGENT";
    case "embeddings":
      return "EMBEDDING";
    default:
      return "DEFAULT";
  }
}

/** Whether a property value can be edited in the UI. */
export function isEditable(value: PropValue): boolean {
  return (
    value.kind !== "raw" && !(value.kind === "functionCall" && !value.binding)
  );
}

/**
 * Whether the UI should offer to edit a slot, which takes two answers: the
 * SDK's (`capable` — does it take an arbitrary value here?) and the value's
 * own (is its current shape one the editor can round-trip?). An empty slot
 * has no shape to object to.
 */
export function canEdit(
  capable: boolean,
  value: PropValue | undefined,
): boolean {
  return capable && (value === undefined || isEditable(value));
}

export function isPropValue(a: unknown): a is PropValue {
  return !!a && typeof a === "object" && "kind" in a;
}

/** `text` parsed as JSON, or `undefined` if it isn't valid JSON. */
export function tryParseJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `v` parsed as JSON if it's a JSON-string, or `v` itself otherwise (not a string, or not valid JSON). */
export function parseJsonOrRaw(v: unknown): unknown {
  return tryParseJson(v) ?? v;
}
