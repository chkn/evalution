// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Plain JSON values to and from the `PropValue` shape ts-proppy's editors
 * expect. Shared by the client (rendering a resource's value preview through
 * the editor a slot's own value would use) and the MCP server (whose callers
 * send and read plain JSON, not `PropValue`s).
 */

import type { PropValue } from "ts-proppy";

/**
 * Converts a plain JSON value into a `PropValue`. Only the data kinds a plain
 * value can be are produced — never a `template`, `functionCall`, or other
 * authored-source kind.
 */
export function jsonToPropValue(value: unknown): PropValue {
  if (Array.isArray(value)) {
    return { kind: "array", elements: value.map(jsonToPropValue) };
  }
  if (value !== null && typeof value === "object") {
    return {
      kind: "object",
      properties: Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, jsonToPropValue(v)]),
      ),
    };
  }
  return {
    kind: "primitive",
    value: value as string | number | boolean | null,
  };
}

/**
 * The plain JSON value a `PropValue` stands for, or `undefined` when it isn't
 * plain data — a template, a function call, a reference, or anything else
 * that only means something as source. The inverse of
 * {@link jsonToPropValue}.
 */
export function propValueToJson(value: PropValue): unknown {
  switch (value.kind) {
    case "primitive":
      return value.value ?? null;
    case "array":
    case "tuple": {
      const elements = value.elements.map(propValueToJson);
      return elements.includes(undefined) ? undefined : elements;
    }
    case "object": {
      const entries = Object.entries(value.properties).map(
        ([key, v]) => [key, propValueToJson(v)] as const,
      );
      return entries.some(([, v]) => v === undefined)
        ? undefined
        : Object.fromEntries(entries);
    }
    case "template":
      // A template with no interpolations is just a string.
      return value.value.every(part => typeof part === "string")
        ? value.value.join("")
        : undefined;
    default:
      return undefined;
  }
}
