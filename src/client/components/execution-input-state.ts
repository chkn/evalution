// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { unboundRequired } from "../../shared/eval-problems";
import { ELEMENT_SLOT } from "../../shared/input-references";
import type {
  ExecutionInput,
  InputLayout,
  NormalizedPrompt,
  PropDefinition,
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
 * converting the `value` variant into the nestable `object` (or `array`)
 * variant only along the path that needs it.
 */
function overlay(
  input: ExecutionInput,
  path: string[],
  replacement: ExecutionInput,
): ExecutionInput {
  if (path.length === 0) return replacement;

  const [head, ...rest] = path;
  const elements = elementsOf(input);
  if (elements) {
    const index = Number(head);
    const next = [...elements];
    next[index] = overlay(
      next[index] ?? { kind: "object", properties: {} },
      rest,
      replacement,
    );
    return { kind: "array", elements: next };
  }
  const properties = { ...propertiesOf(input) };
  properties[head] = overlay(
    properties[head] ?? { kind: "object", properties: {} },
    rest,
    replacement,
  );
  return { kind: "object", properties };
}

/** The child inputs of `input` when it is an array, by index. */
function elementsOf(input: ExecutionInput): ExecutionInput[] | undefined {
  if (input.kind === "array") return input.elements;
  if (input.kind === "value" && input.value.kind === "array") {
    // A hand-edited array being partly overridden: lift its elements into
    // inputs so the untouched ones keep their places beside the resource.
    return input.value.elements.map(
      (v): ExecutionInput => ({ kind: "value", value: v }),
    );
  }
  return undefined;
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

/** What a bound array element holds in the value: nothing of its own. */
const PLACEHOLDER: PropValue = { kind: "primitive", value: undefined };

function isContainer(value: PropValue | undefined): value is PropValue {
  return value?.kind === "object" || value?.kind === "array";
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
        setAtPath(prefix, node.value);
        break;
      case "object":
        for (const [key, child] of Object.entries(node.properties)) {
          walk(child, prefix === SELF ? key : `${prefix}.${key}`);
        }
        break;
      case "array":
        // Every element keeps its place in the value — a bound one as a
        // placeholder — so the editor still shows a row for it, and the
        // indices `resources` names line up with the value's.
        setAtPath(prefix, {
          kind: "array",
          elements: node.elements.map(() => PLACEHOLDER),
        });
        node.elements.forEach((child, i) => {
          walk(child, prefix === SELF ? String(i) : `${prefix}.${i}`);
        });
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

  // Sets `leaf` at `path` within `value`. Every array on the way was put in
  // place, at its full length, by the walk before its elements are reached.
  const setAtPath = (path: string, leaf: PropValue) => {
    if (path === SELF) {
      value = leaf;
      return;
    }
    const segments = path.split(".");
    if (value?.kind !== "object" && value?.kind !== "array") {
      value = { kind: "object", properties: {} };
    }
    let cursor: PropValue = value;
    for (const [i, segment] of segments.entries()) {
      const last = i === segments.length - 1;
      if (cursor.kind === "array") {
        const index = Number(segment);
        if (last) cursor.elements[index] = leaf;
        else if (!isContainer(cursor.elements[index])) {
          cursor.elements[index] = { kind: "object", properties: {} };
        }
        if (!last) cursor = cursor.elements[index];
      } else if (cursor.kind === "object") {
        if (last) cursor.properties[segment] = leaf;
        else if (!isContainer(cursor.properties[segment])) {
          cursor.properties[segment] = { kind: "object", properties: {} };
        }
        if (!last) cursor = cursor.properties[segment];
      }
    }
  };

  walk(input, SELF);
  return {
    ...(value ? { value } : {}),
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
  };
}

/**
 * Why `input` can't run `param`, in the panel's words: the slot left empty,
 * or the first required property an object input leaves out (`toolsContext`
 * missing a field its tool's context grew). `undefined` when nothing is.
 *
 * @param hasSources - Whether the prompt offers resources, so an opaque
 *   property can be pointed at them.
 */
export function missingInputMessage(
  param: PropDefinition,
  input: ExecutionInput | undefined,
  hasSources: boolean,
): string | undefined {
  const [path] = input
    ? unboundRequired([param], { [param.name]: input })
    : [param.name];
  if (path === undefined) return undefined;
  // The property the path ends at, for its type.
  let prop = param;
  for (const name of path.split(".").slice(1)) {
    if (prop.type.kind !== "object") break;
    prop = prop.type.properties.find(p => p.name === name) ?? prop;
  }
  if (prop.type.kind !== "opaque") {
    return `Parameter '${path}' is required`;
  }
  return hasSources
    ? `Parameter '${path}' needs a resource — pick one from its dropdown`
    : `Parameter '${path}' is a ${prop.type.syntax}, which can't be typed in. ` +
        `Export a resource() from a *.playground.ts beside the prompt, or from ` +
        `.evalution/playground/, to supply one.`;
}

/**
 * `resources` after the element at `index` of the array at `arrayPath` is
 * removed: that element's sources (its own, and any nested inside it) go,
 * and every later element's move down one index with it, so each source
 * stays with the element it was chosen for.
 *
 * @param resources - A slot's chosen sources, by path relative to the slot
 *   (see {@link SlotSelection.resources}).
 * @param arrayPath - The array's path, relative to the slot the same way:
 *   {@link SELF} for the slot itself.
 */
export function shiftForRemovedElement(
  resources: Readonly<Record<string, string>>,
  arrayPath: string,
  index: number,
): Record<string, string> {
  const prefix = arrayPath === SELF ? "" : `${arrayPath}.`;
  const out: Record<string, string> = {};
  for (const [path, uri] of Object.entries(resources)) {
    if (path === SELF || !path.startsWith(prefix)) {
      out[path] = uri;
      continue;
    }
    const [head, ...rest] = path.slice(prefix.length).split(".");
    const at = /^\d+$/.test(head) ? Number(head) : undefined;
    if (at === undefined || at < index) out[path] = uri;
    else if (at > index) out[[`${prefix}${at - 1}`, ...rest].join(".")] = uri;
  }
  return out;
}

/**
 * Which of `slots` the slot at `path` is matched as: the path itself, or,
 * with each element index read as {@link ELEMENT_SLOT}, its array's element
 * slot (`after.3` → `after.[]`). `undefined` when neither is a slot.
 */
export function matchingSlotPath(
  slots: Readonly<Record<string, readonly string[]>>,
  path: string,
): string | undefined {
  if (Object.hasOwn(slots, path)) return path;
  const asElement = path
    .split(".")
    .map(segment => (/^\d+$/.test(segment) ? ELEMENT_SLOT : segment))
    .join(".");
  return Object.hasOwn(slots, asElement) ? asElement : undefined;
}
