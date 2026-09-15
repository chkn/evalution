// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { materializeValue } from "ts-proppy";
import type {
  ExecutionInput,
  PropDefinition,
  PropType,
} from "../shared/types.ts";
import {
  type ResourceBinding,
  receiptKeyOf,
} from "./playground/resource-registry.ts";

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

/**
 * How an {@link ExecutionInput} of kind `resource` is turned into a value.
 *
 * `binding` is passed when the resource has arguments and/or a replay
 * receipt to hand back — see {@link ResourceBinding} and
 * `specs/resource-arguments.md` §D. A resolver that ignores it (as any
 * resolver predating arguments does) still gets the resource's plain value,
 * unparameterized, the same as before.
 */
export type ResourceResolver = (
  uri: string,
  binding?: ResourceBinding,
) => Promise<unknown>;

/**
 * The stable JSON encoding of a resource reference's `args` — object keys
 * sorted recursively, computed over the *unresolved* recipe so a resolved
 * argument that turns out to be a live handle never has to be compared or
 * hashed. Absent `args` and `{}` both encode to `""`, which is what makes an
 * existing argument-free reference key identically to before this existed.
 *
 * This is the lease's memoization key for one (resource, arguments) pair —
 * see `specs/resource-arguments.md` §D.
 */
export function canonicalArgumentKey(
  args: Record<string, ExecutionInput> | undefined,
): string {
  if (!args || Object.keys(args).length === 0) return "";
  return stableStringify(args);
}

/** `JSON.stringify`, but with every object's keys sorted first. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      k =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

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
      // No binding at all — not even one carrying an empty `args` — for a
      // reference with neither arguments nor a receipt, so a lease sees
      // exactly the call it would have seen before either existed.
      if (!input.args && input.receipt === undefined) {
        return resolveResource(input.uri);
      }
      const binding: ResourceBinding = {
        key: canonicalArgumentKey(input.args),
        // Recursion is free: an argument is itself an `ExecutionInput`, so
        // resolving the whole `args` map is exactly resolving an `object`
        // input's `properties` — see the `object` case above. Evaluated
        // lazily, only once the lease has decided this binding doesn't hit
        // its memo (see `ResourceBinding.resolve`).
        resolve: async () => {
          const entries = await Promise.all(
            Object.entries(input.args ?? {}).map(
              async ([k, v]) =>
                [k, await resolveExecutionInput(v, resolveResource)] as const,
            ),
          );
          return Object.fromEntries(entries);
        },
        receipt: input.receipt,
      };
      return resolveResource(input.uri, binding);
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

/**
 * Returns `inputs` with every resource reference's `receipt` set from
 * `receipts` — the shape `ResourceLease.receipts()` /
 * `ResolvedPromptInputs.receipts` produce — so the inputs recorded on a
 * trace carry what this run's resources actually produced.
 *
 * A receipt is looked up by the same key `ResourceRegistry` records it
 * under: the reference's own `uri`, or `` `${uri}@${key}` `` where `key` is
 * {@link canonicalArgumentKey} of its (already-unresolved) `args` — so a
 * fresh run's receipt lands on the exact reference that produced it, however
 * many differently-bound references to the same resource a request has.
 * Nested references (an argument that is itself a resource, a resource
 * inside an `object` input) are stamped too. See
 * `specs/resource-arguments.md` §K.
 *
 * @param inputs - The unresolved inputs a request was sent with.
 * @param receipts - What the run's resolution produced, if anything did.
 */
export function stampReceipts(
  inputs: {
    functionInputs?: readonly ExecutionInput[];
    executeInputs?: Record<string, ExecutionInput>;
  },
  receipts: Record<string, unknown> | undefined,
): {
  functionInputs?: readonly ExecutionInput[];
  executeInputs?: Record<string, ExecutionInput>;
} {
  if (!receipts) return inputs;

  const stampAll = (map: Record<string, ExecutionInput>) =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, stamp(v)]));

  const stamp = (input: ExecutionInput): ExecutionInput => {
    switch (input.kind) {
      case "resource": {
        // Built fresh rather than spread from `input`, so a replay's incoming
        // receipt never outlives a run whose `create` didn't produce one.
        const stamped: ExecutionInput = { kind: "resource", uri: input.uri };
        if (input.args) stamped.args = stampAll(input.args);
        const receipt =
          receipts[receiptKeyOf(input.uri, canonicalArgumentKey(input.args))];
        if (receipt !== undefined) stamped.receipt = receipt;
        return stamped;
      }
      case "object":
        return { ...input, properties: stampAll(input.properties) };
      default:
        return input;
    }
  };

  return {
    functionInputs: inputs.functionInputs?.map(stamp),
    executeInputs: inputs.executeInputs && stampAll(inputs.executeInputs),
  };
}
