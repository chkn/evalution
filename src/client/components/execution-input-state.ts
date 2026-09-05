// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ExecutionInput, PropValue } from "../../shared/types";

/**
 * What the panel holds for one top-level slot while it is being edited.
 *
 * Kept apart from {@link ExecutionInput} because editing has a state the wire
 * format has no reason to carry: a hand-edited value *and* a set of nested
 * slots that have been handed to a resource instead. `toExecutionInput` folds
 * the two together at submit time.
 */
export interface SlotSelection {
  /** The value typed into the editor, if any. */
  value?: PropValue;
  /**
   * Resource chosen for a slot, keyed by the slot's dotted path relative to
   * this top-level slot (`''` for the slot itself, `'db'` for a nested field).
   *
   * Nested entries are what let a resource fill one field of an otherwise
   * hand-edited object — `toolsContext`'s `db` beside its typed-in ids.
   */
  resources?: Record<string, string>;
}

/** The path key used for the top-level slot itself. */
export const SELF = "";

/**
 * Fold a slot's editor state into the input to send.
 *
 * A resource chosen for the slot itself wins outright. Otherwise nested
 * choices are grafted onto the typed-in value, producing the `object` variant
 * only where one is actually needed — a slot with no nested resources stays a
 * plain `value`, which is also what makes it restore exactly on replay.
 */
export function toExecutionInput(
  selection: SlotSelection | undefined,
): ExecutionInput | undefined {
  if (!selection) return undefined;

  const resources = selection.resources ?? {};
  const own = resources[SELF];
  if (own) return { kind: "resource", uri: own };

  const nested = Object.entries(resources).filter(([path]) => path !== SELF);
  if (nested.length === 0) {
    return selection.value
      ? { kind: "value", value: selection.value }
      : undefined;
  }

  // Build the object tree from the value, then overlay each nested choice at
  // its path.
  const root: ExecutionInput = selection.value
    ? { kind: "value", value: selection.value }
    : { kind: "object", properties: {} };

  let out: ExecutionInput = root;
  for (const [path, uri] of nested) {
    out = overlay(out, path.split("."), { kind: "resource", uri });
  }
  return out;
}

/**
 * Replace whatever sits at `path` inside `input` with `replacement`,
 * converting the `value` variant into the nestable `object` variant only along
 * the path that needs it.
 */
function overlay(
  input: ExecutionInput,
  path: string[],
  replacement: ExecutionInput,
): ExecutionInput {
  if (path.length === 0) return replacement;

  const [head, ...rest] = path;
  const properties = { ...propertiesOf(input) };
  properties[head] = overlay(
    properties[head] ?? { kind: "object", properties: {} },
    rest,
    replacement,
  );
  return { kind: "object", properties };
}

/** The child inputs of `input`, seen as an object. */
function propertiesOf(input: ExecutionInput): Record<string, ExecutionInput> {
  if (input.kind === "object") return input.properties;
  if (input.kind === "value" && input.value.kind === "object") {
    // A hand-edited object being partly overridden: lift its properties into
    // inputs so the untouched ones survive alongside the resource.
    return Object.fromEntries(
      Object.entries(input.value.properties).map(([k, v]) => [
        k,
        { kind: "value", value: v } as ExecutionInput,
      ]),
    );
  }
  return {};
}

/**
 * Recover editor state from a stored or recorded input.
 *
 * The inverse of {@link toExecutionInput}, and lossless for what the panel
 * actually shows: a `value` comes back in its original `PropValue` form (a
 * template stays a template rather than the flattened string a materialized
 * value would have left behind), and a resource comes back as a chip.
 */
export function fromExecutionInput(
  input: ExecutionInput | undefined,
): SlotSelection {
  if (!input) return {};

  const resources: Record<string, string> = {};
  let value: PropValue | undefined;

  const walk = (node: ExecutionInput, prefix: string) => {
    switch (node.kind) {
      case "resource":
        resources[prefix] = node.uri;
        break;
      case "value":
        if (prefix === SELF) value = node.value;
        else setAtPath(prefix, node.value);
        break;
      case "object":
        for (const [key, child] of Object.entries(node.properties)) {
          walk(child, prefix === SELF ? key : `${prefix}.${key}`);
        }
        break;
      case "dataset":
        // Not implemented; nothing to restore into the editor yet.
        break;
    }
  };

  const setAtPath = (path: string, leaf: PropValue) => {
    const segments = path.split(".");
    if (value?.kind !== "object") {
      value = { kind: "object", properties: {} };
    }
    let cursor = value as Extract<PropValue, { kind: "object" }>;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor.properties[segment];
      if (next?.kind !== "object") {
        cursor.properties[segment] = { kind: "object", properties: {} };
      }
      cursor = cursor.properties[segment] as Extract<
        PropValue,
        { kind: "object" }
      >;
    }
    cursor.properties[segments[segments.length - 1]] = leaf;
  };

  walk(input, SELF);
  return {
    ...(value ? { value } : {}),
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
  };
}
