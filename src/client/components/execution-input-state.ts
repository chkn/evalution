// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  ExecutionInput,
  InputLayout,
  NormalizedPrompt,
  PropValue,
  RunResources,
} from "../../shared/types";
import { pseudoInput, pseudoUriOf } from "./pseudo-sources";

/**
 * What the execute panel persists between sessions, per prompt: the inputs
 * themselves, not the values.
 */
export interface StoredInputs {
  functionInputs?: Record<string, ExecutionInput>;
  executeInputs?: Record<string, ExecutionInput>;
  /** The run's named resource instances. See `specs/resource-instances.md`. */
  resources?: RunResources;
  /** The user's explicit layout choice, by slot path. Absent until they touch the toggle. */
  layout?: {
    functionSlots?: Record<string, InputLayout>;
    executeSlots?: Record<string, InputLayout>;
  };
}

/**
 * Where the execute panel persists `prompt`'s inputs. `globalId` survives
 * file moves/renames, so it's the more stable key when present; `id`
 * (always present) is the fallback.
 */
export function paramStorageKey(prompt: NormalizedPrompt): string {
  return `pg-exec-params:${prompt.globalId ?? prompt.id}`;
}

/** The panel's persisted inputs for `prompt`, if any parse. */
export function readStoredInputs(
  prompt: NormalizedPrompt,
): StoredInputs | undefined {
  try {
    const raw = localStorage.getItem(paramStorageKey(prompt));
    const parsed = raw ? JSON.parse(raw) : undefined;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the panel holds for one top-level slot while it is being edited.
 *
 * Kept apart from {@link ExecutionInput} because editing has a state the wire
 * format has no reason to carry: a hand-edited value *and* a set of nested
 * slots that have been handed to a source instead. `toExecutionInput` folds
 * the two together at submit time.
 */
export interface SlotSelection {
  /** The value typed into the editor, if any. */
  value?: PropValue;
  /**
   * Source chosen for a slot — a pseudo-source URI naming one of the run's
   * resource instances, a column, or another slot (see `pseudo-sources.ts`)
   * — keyed by the slot's dotted path relative to this top-level slot (`''`
   * for the slot itself, `'db'` for a nested field).
   *
   * Nested entries are what let a resource fill one field of an otherwise
   * hand-edited object — `toolsContext`'s `db` beside its typed-in ids.
   */
  resources?: Record<string, string>;
}

/** Editor state for one set of slots, keyed by slot (or argument) name. */
export type Selections = Record<string, SlotSelection>;

/** The path key used for the top-level slot itself. */
export const SELF = "";

/**
 * Fold a slot's editor state into the input to send.
 *
 * A source chosen for the slot itself wins outright. Otherwise nested
 * choices are grafted onto the typed-in value, producing the `object` variant
 * only where one is actually needed — a slot with no nested sources stays a
 * plain `value`, which is also what makes it restore exactly on replay.
 *
 * A chosen URI that isn't a pseudo-source (a catalog resource, which a host
 * turns into an instance as it's picked) stands for nothing on the wire and
 * is left out.
 */
export function toExecutionInput(
  selection: SlotSelection | undefined,
): ExecutionInput | undefined {
  if (!selection) return undefined;

  const resources = selection.resources ?? {};
  const own = resources[SELF];
  if (own) return pseudoInput(own);

  const nested = Object.entries(resources).flatMap(([path, uri]) => {
    if (path === SELF) return [];
    const input = pseudoInput(uri);
    return input ? [[path, input] as const] : [];
  });
  if (nested.length === 0) {
    return selection.value
      ? { kind: "value", value: selection.value }
      : undefined;
  }

  // Build the object tree from the value, then overlay each nested choice at
  // its path.
  let out: ExecutionInput = selection.value
    ? { kind: "value", value: selection.value }
    : { kind: "object", properties: {} };
  for (const [path, input] of nested) {
    out = overlay(out, path.split("."), input);
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
 * value would have left behind), and an instance, column or slot reference
 * comes back as the chip it was chosen as. Anything else — an inline
 * `resource` node stored before instances existed — comes back empty rather
 * than failing.
 */
export function fromExecutionInput(
  input: ExecutionInput | undefined,
): SlotSelection {
  if (!input) return {};

  const resources: Record<string, string> = {};
  let value: PropValue | undefined;
  const walk = (node: ExecutionInput, prefix: string) => {
    switch (node.kind) {
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
      case "input":
      case "instance":
        // A column, another slot or an instance comes back as the chip it
        // was chosen as.
        resources[prefix] = pseudoUriOf(node)!;
        break;
      default:
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
