// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  ExecutionInput,
  PropValue,
  ResourceInfo,
} from "../../shared/types";

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

/** Editor state for one set of slots, keyed by slot (or argument) name. */
export type Selections = Record<string, SlotSelection>;

/**
 * Argument editor state, held once per resource `uri` and shared by every
 * selection of it — the panel-level counterpart of `ExecutionInput.args`
 * (`specs/resource-arguments.md` §I, §J).
 *
 * Kept as a sibling map rather than per slot because arguments are a property
 * of the *resource*, the same reason `ResourceInfo.parameters` is: picking
 * `seededTask.taskId` for one slot and `seededTask.title` for another edits
 * one set of arguments, not two.
 */
export type ResourceArgs = Record<string, Selections>;

/** The path key used for the top-level slot itself. */
export const SELF = "";

/**
 * Fold a slot's editor state into the input to send.
 *
 * A resource chosen for the slot itself wins outright. Otherwise nested
 * choices are grafted onto the typed-in value, producing the `object` variant
 * only where one is actually needed — a slot with no nested resources stays a
 * plain `value`, which is also what makes it restore exactly on replay.
 *
 * @param selection - This slot's own editor state.
 * @param resolveArgs - Given a chosen resource's `uri`, returns the `args` it
 *   should carry (built from {@link ResourceArgs} — see
 *   {@link resourceArgsFor}), or `undefined` if it takes none. Recursive: an
 *   argument that is itself a resource gets its own `args` resolved the same
 *   way, which is how `resourceArgsFor` calls back into this function.
 */
export function toExecutionInput(
  selection: SlotSelection | undefined,
  resolveArgs?: (uri: string) => Record<string, ExecutionInput> | undefined,
): ExecutionInput | undefined {
  if (!selection) return undefined;

  const resources = selection.resources ?? {};
  const own = resources[SELF];
  if (own) return resourceInput(own, resolveArgs);

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
    out = overlay(out, path.split("."), resourceInput(uri, resolveArgs));
  }
  return out;
}

/** A `{ kind: "resource" }` node, with `args` attached when `resolveArgs` has any. */
function resourceInput(
  uri: string,
  resolveArgs?: (uri: string) => Record<string, ExecutionInput> | undefined,
): ExecutionInput {
  const args = resolveArgs?.(uri);
  return args ? { kind: "resource", uri, args } : { kind: "resource", uri };
}

/**
 * Builds the `args` a reference to `uri` should carry: one entry per its
 * `ResourceInfo.parameters`, taken from `resourceArgs[uri]` and folded
 * through {@link toExecutionInput} the same as any other slot — recursively,
 * so an argument that is itself a resource gets its own `args` the same way.
 *
 * Meant to be passed (partially applied over `resourceArgs` and
 * `resourcesByUri`) as {@link toExecutionInput}'s `resolveArgs`.
 *
 * @param uri - The resource whose arguments to build.
 * @param resourceArgs - The panel's whole argument-editor state.
 * @param resourcesByUri - Every resource in scope, for parameter lookup.
 */
export function resourceArgsFor(
  uri: string,
  resourceArgs: ResourceArgs,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): Record<string, ExecutionInput> | undefined {
  // `uri` may name an output value (`seededTask.taskId`) rather than the
  // resource itself — only the root carries `parameters`, and §I's "one
  // binding per resource" means the args live (and are looked up) under the
  // *root's* uri regardless of which of its values was actually picked.
  const root = rootResourceUri(uri, resourcesByUri);
  const params = resourcesByUri.get(root)?.parameters;
  if (!params || params.length === 0) return undefined;

  const selections = resourceArgs[root] ?? {};
  const entries = params.flatMap(param => {
    const input = toExecutionInput(selections[param.name], childUri =>
      resourceArgsFor(childUri, resourceArgs, resourcesByUri),
    );
    return input ? [[param.name, input] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * `uri` itself, or the resource it's an output value of (`ResourceInfo.parent`)
 * — the key {@link ResourceArgs} and `ResourceArgsContext.resourceSlots` /
 * `.claimed` are all addressed by, so that choosing `seededTask.taskId` for
 * one slot and `seededTask.title` for another shares one set of arguments.
 */
export function rootResourceUri(
  uri: string,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): string {
  return resourcesByUri.get(uri)?.parent ?? uri;
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

/** What {@link fromExecutionInput} recovers from a stored or recorded input. */
export interface RecoveredInput {
  /** This slot's own editor state — the direct inverse of the old `fromExecutionInput` result. */
  selection: SlotSelection;
  /**
   * Argument editor state for every resource (at any depth) the input named
   * with `args` — merge into the panel's {@link ResourceArgs}. Empty when
   * nothing in the input had arguments.
   */
  resourceArgs: ResourceArgs;
}

/**
 * Recover editor state from a stored or recorded input.
 *
 * The inverse of {@link toExecutionInput}, and lossless for what the panel
 * actually shows: a `value` comes back in its original `PropValue` form (a
 * template stays a template rather than the flattened string a materialized
 * value would have left behind), a resource comes back as a chip, and a
 * resource's `args` come back as {@link ResourceArgs} entries the caller
 * merges into the panel's own map — restoring the shared-by-uri binding
 * `specs/resource-arguments.md` §I describes, not a copy per reference.
 *
 * @param resourcesByUri - When given, a recovered resource's `args` are
 *   keyed by its *root* uri ({@link rootResourceUri}) rather than by
 *   whichever of its values the reference actually named — the same
 *   resolution {@link resourceArgsFor} does, and necessary for the same
 *   reason: `seededTask.taskId`'s recorded `args` belong to `seededTask`,
 *   not to a key nothing else will ever look up. Omit only when no resource
 *   in the tree could possibly be a value reference (e.g. recovering a
 *   resource's own already-rooted argument, as this function does for
 *   itself below).
 */
export function fromExecutionInput(
  input: ExecutionInput | undefined,
  resourcesByUri?: ReadonlyMap<string, ResourceInfo>,
): RecoveredInput {
  if (!input) return { selection: {}, resourceArgs: {} };

  const resources: Record<string, string> = {};
  let value: PropValue | undefined;
  const resourceArgs: ResourceArgs = {};

  const captureArgs = (
    uri: string,
    args: Record<string, ExecutionInput> | undefined,
  ) => {
    if (!args) return;
    const selections: Selections = {};
    for (const [paramName, argInput] of Object.entries(args)) {
      const recovered = fromExecutionInput(argInput, resourcesByUri);
      selections[paramName] = recovered.selection;
      Object.assign(resourceArgs, recovered.resourceArgs);
    }
    const root = resourcesByUri ? rootResourceUri(uri, resourcesByUri) : uri;
    // Last-writer-wins where two references to `root` disagree — harmless in
    // practice (see the doc comment above) and never happens for a binding
    // this panel itself produced, since §I holds one per uri.
    resourceArgs[root] = selections;
  };

  const walk = (node: ExecutionInput, prefix: string) => {
    switch (node.kind) {
      case "resource":
        resources[prefix] = node.uri;
        captureArgs(node.uri, node.args);
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
    selection: {
      ...(value ? { value } : {}),
      ...(Object.keys(resources).length > 0 ? { resources } : {}),
    },
    resourceArgs,
  };
}
