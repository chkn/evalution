// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { materializeValue } from "ts-proppy";
import type {
  ExecutionInput,
  PropDefinition,
  PropType,
} from "../shared/types.ts";

/**
 * One place an input can be plugged in: a prompt's parameter, or any slot
 * nested inside one.
 *
 * Flattening the parameter tree into paths is what lets a source be matched
 * against a nested field — `toolsContext.list_tasks.db` — without the matching
 * rules having to know anything about the shape they are walking.
 */
export interface InputSlot {
  /** Dotted path from the root parameter (`taskId`, `ctx.db`). */
  path: string;
  /** The slot's own name — the last path segment. */
  name: string;
  /** The slot's type. */
  type: PropType;
}

/**
 * A candidate source for a slot, in whatever vocabulary the caller has.
 *
 * Deliberately source-agnostic: a code-defined resource and a dataset row's
 * column are both "something with a key, maybe a declared type, maybe an
 * explicit target", so both reuse these rules rather than growing their own.
 */
export interface InputSource {
  /** How the resolved input will refer to this source. */
  uri: string;
  /** The source's own name — a resource's export name, a row's column name. */
  key: string;
  /**
   * Explicit slot path(s) this source fills, optionally prefixed by a prompt
   * name (`orchestrate.taskId`). Always wins when it matches.
   */
  for?: string | readonly string[];
  /**
   * Whether this source can fill a slot of the given type, as decided by the
   * checker. Absent when no checker was available, in which case matching
   * falls back to the name rule.
   */
  fitsType?: (type: PropType, path: string) => boolean;
}

/**
 * How deep to walk a parameter's type looking for nested slots.
 *
 * The checker-backed walk in `ts/slot-matching.ts` has to agree with this one,
 * or a slot would be offered a source at a path this side never produces.
 */
export const MAX_SLOT_DEPTH = 4;

/**
 * Flatten `definitions` into every slot a source could be matched against —
 * each parameter, plus the object properties nested inside it.
 *
 * Arrays and unions are not descended into: neither has a stable path a
 * saved input selection could still name after the value changes shape.
 *
 * @param definitions - The parameters to flatten.
 * @param prefix - Path prefix, used when recursing.
 */
export function collectInputSlots(
  definitions: readonly PropDefinition[],
  prefix = "",
  depth = 0,
): InputSlot[] {
  const slots: InputSlot[] = [];
  for (const def of definitions) {
    const path = prefix ? `${prefix}.${def.name}` : def.name;
    slots.push({ path, name: def.name, type: def.type });
    if (def.type.kind === "object" && depth + 1 < MAX_SLOT_DEPTH) {
      slots.push(...collectInputSlots(def.type.properties, path, depth + 1));
    }
  }
  return slots;
}

/**
 * Match sources to slots — three strategies, first match wins.
 *
 * 1. **Explicit.** The source names the slot in `for`. An escape hatch that
 *    always works, and the only one that can reach a slot the other two miss.
 * 2. **Type.** The source's declared type fits the slot's, as the checker sees
 *    it. Offered on *every* slot of that type, anywhere, without naming one —
 *    and offered *beside* an editable slot's editor, never instead of it,
 *    because whether a slot has an editor is a property of its type alone.
 * 3. **Name.** The source's key equals the slot's name. The fallback when no
 *    checker is available, which is the documented in-memory-provider
 *    situation: cross-file types stay unresolved and there is nothing for rule
 *    2 to compare.
 *
 * @param slots - The slots to fill, from {@link collectInputSlots}.
 * @param sources - The candidates.
 * @param promptName - Used to accept a `for` that is prefixed with it.
 * @returns Slot path → URIs of the sources that can fill it, in source order.
 */
export function matchSourcesToSlots(
  slots: readonly InputSlot[],
  sources: readonly InputSource[],
  promptName?: string,
): Record<string, string[]> {
  const matches: Record<string, string[]> = {};

  const add = (path: string, uri: string) => {
    const existing = matches[path];
    if (existing) existing.push(uri);
    else matches[path] = [uri];
  };

  for (const source of sources) {
    const explicit = new Set(
      (typeof source.for === "string" ? [source.for] : (source.for ?? [])).map(
        f =>
          promptName && f.startsWith(`${promptName}.`)
            ? f.slice(promptName.length + 1)
            : f,
      ),
    );

    for (const slot of slots) {
      if (explicit.size > 0) {
        // An explicit `for` is a statement about where this source belongs, so
        // it also *excludes* the slots it doesn't name — otherwise pinning one
        // slot would still leave the source offered on every other match.
        if (explicit.has(slot.path)) add(slot.path, source.uri);
        continue;
      }
      if (source.fitsType) {
        if (source.fitsType(slot.type, slot.path)) add(slot.path, source.uri);
        continue;
      }
      if (source.key === slot.name) add(slot.path, source.uri);
    }
  }

  return matches;
}

/** How an {@link ExecutionInput} of kind `resource` is turned into a value. */
export type ResourceResolver = (uri: string) => Promise<unknown>;

/**
 * Turn one {@link ExecutionInput} into the concrete value to pass to a prompt.
 *
 * This runs server-side, which is the point: `materializeValue` has to be able
 * to `import()` a parameter's function binding, and a resource has to be
 * created in the process that will run the prompt.
 *
 * @param input - The unresolved input.
 * @param resolveResource - Creates the value behind a `resource` reference.
 */
export async function resolveExecutionInput(
  input: ExecutionInput,
  resolveResource?: ResourceResolver,
): Promise<unknown> {
  switch (input.kind) {
    case "value":
      return materializeValue(input.value);

    case "object": {
      const entries = await Promise.all(
        Object.entries(input.properties).map(
          async ([k, v]) =>
            [k, await resolveExecutionInput(v, resolveResource)] as const,
        ),
      );
      return Object.fromEntries(entries);
    }

    case "resource": {
      if (!resolveResource) {
        throw new Error(
          `Cannot resolve resource '${input.uri}': this provider does not offer resources.`,
        );
      }
      return resolveResource(input.uri);
    }

    case "dataset":
      throw new Error(
        `Dataset inputs are not implemented yet (referenced '${input.uri}').`,
      );
  }
}

/**
 * Resolve a whole execute request's inputs.
 *
 * Both halves are resolved together, and `resolveResource` is expected to
 * memoize: a run-scoped resource referenced by both a function input and an
 * execute input must be created **once** per run, which is only decidable when
 * every input is in view.
 */
export async function resolveExecutionInputs(
  inputs: {
    functionInputs?: readonly ExecutionInput[];
    executeInputs?: Record<string, ExecutionInput>;
  },
  resolveResource?: ResourceResolver,
): Promise<{ functionParams: any[]; executeValues: Record<string, any> }> {
  const functionParams = await Promise.all(
    (inputs.functionInputs ?? []).map(i =>
      resolveExecutionInput(i, resolveResource),
    ),
  );

  const executeEntries = await Promise.all(
    Object.entries(inputs.executeInputs ?? {}).map(
      async ([name, input]) =>
        [name, await resolveExecutionInput(input, resolveResource)] as const,
    ),
  );

  return {
    functionParams,
    executeValues: Object.fromEntries(executeEntries),
  };
}
