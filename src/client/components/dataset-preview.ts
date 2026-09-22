// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * One-line previews of dataset cells for the dataset table. Pure. The table
 * has no `inputSources` to label a resource with, so a resource is shown by
 * its export name — the part of its `uri` after `#`.
 */

import type { ExecutionInput, PropValue } from "../../shared/types";

/** How long a preview may get before it's cut with an ellipsis. */
const MAX_PREVIEW = 60;

function truncate(text: string, max = MAX_PREVIEW): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A compact, single-line rendering of a `PropValue`. Templates show their text. */
export function previewPropValue(value: PropValue): string {
  switch (value.kind) {
    case "primitive":
      return value.value === undefined
        ? "—"
        : typeof value.value === "string"
          ? JSON.stringify(value.value)
          : String(value.value);
    case "template":
      return `"${value.value
        .map(part => (typeof part === "string" ? part : `\${${part.expr}}`))
        .join("")}"`;
    case "object": {
      const keys = Object.keys(value.properties);
      return keys.length === 0 ? "{}" : `{ ${keys.join(", ")} }`;
    }
    case "array":
    case "tuple":
      return `[${value.elements.length}]`;
    case "functionCall":
      return `${value.callee}(…)`;
    case "reference":
      return value.path.join(".");
    case "lambda":
      return `(${value.parameters.join(", ")}) => …`;
    case "raw":
      return value.sourceText;
  }
}

/** A resource's display name: its export, after `#` (the whole `uri` if none). */
export function resourceName(uri: string): string {
  const hash = uri.lastIndexOf("#");
  return hash >= 0 ? uri.slice(hash + 1) : uri;
}

/** A one-line summary of a resource's arguments: `title: "Milk", owner: db`. */
export function previewArgs(
  args: Record<string, ExecutionInput> | undefined,
): string {
  if (!args) return "";
  return truncate(
    Object.entries(args)
      .map(([name, input]) => `${name}: ${previewCell(input)}`)
      .join(", "),
  );
}

/** A one-line preview of any cell. */
export function previewCell(input: ExecutionInput): string {
  switch (input.kind) {
    case "value":
      return truncate(previewPropValue(input.value));
    case "object":
      return "{…}";
    case "resource": {
      const args = previewArgs(input.args);
      return args
        ? `${resourceName(input.uri)}(${args})`
        : resourceName(input.uri);
    }
    case "dataset":
      return input.uri;
  }
}

/**
 * The lines an `object` cell expands to on hover — one per property, each
 * previewed as a cell of its own.
 */
export function objectCellLines(
  input: Extract<ExecutionInput, { kind: "object" }>,
): { key: string; preview: string }[] {
  return Object.entries(input.properties).map(([key, child]) => ({
    key,
    preview: previewCell(child),
  }));
}
