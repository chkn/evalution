// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { materializeValue } from "ts-proppy";
import type { DatasetRow } from "../dataset/dataset-types.ts";
import {
  type InputBindings,
  type InputSlot,
  inputKey,
} from "../shared/input-references.ts";
import type {
  ExecutionInput,
  PropType,
  PropValue,
  RunResources,
} from "../shared/types.ts";
import type { DeclaredInstance } from "./playground/resource-registry.ts";

export {
  collectInputSlots,
  findInputCycle,
  type InputBindings,
  type InputSignature,
  type InputSlot,
  inputReferenceProblems,
  MAX_SLOT_DEPTH,
  namedBindings,
} from "../shared/input-references.ts";

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
 * How a run's named resource instances are created — what
 * `ResourceRegistry.lease()` hands back satisfies it. See
 * `specs/resource-instances.md` §B.
 */
export interface InstanceResolver {
  /** Declares the run's instances. Called once, before anything is acquired. */
  declare(instances: Record<string, DeclaredInstance>): Promise<void>;
  /** The declared instance `name`'s value, or its `output`. Created once per run. */
  acquire(name: string, output?: string): Promise<unknown>;
}

/**
 * What the `dataset` and `input` variants resolve against. Outside an eval
 * run there's no row, and outside a run whose other slots are known there
 * are no bindings; either variant then fails with a message that says so.
 * See `specs/evals.md` §D.1.
 */
export interface ResolutionContext {
  /** The dataset row being run, for `dataset` references. */
  row?: Pick<DatasetRow, "cells">;
  /** The run's own slot bindings, for `input` references. */
  bindings?: InputBindings;
}

/** Reads `path` off a resolved value, `undefined` wherever a step is missing. */
function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * The binding at `path` within `bindings`, descending through `object`
 * inputs and typed-in object values. Where the walk reaches something that
 * has to be resolved first — a resource, a cell, another `input` — it stops,
 * and `rest` is what to read off that node's value.
 */
export function bindingAt(
  bindings: InputBindings,
  half: "function" | "execute",
  path: string,
): { node: ExecutionInput | undefined; rest: string[] } {
  const [head, ...segments] = path.split(".");
  let node: ExecutionInput | undefined = (
    half === "function" ? bindings.functionInputs : bindings.executeInputs
  )[head];
  const rest = [...segments];
  while (node && rest.length > 0) {
    if (node.kind === "object") {
      node = node.properties[rest.shift()!];
    } else if (node.kind === "value" && node.value.kind === "object") {
      const child: PropValue | undefined = node.value.properties[rest.shift()!];
      node = child ? { kind: "value", value: child } : undefined;
    } else {
      break;
    }
  }
  return { node, rest };
}

/**
 * Turn one {@link ExecutionInput} into the concrete value to pass to a prompt.
 *
 * This runs server-side, which is the point: `materializeValue` has to be able
 * to `import()` a parameter's function binding, and a resource has to be
 * created in the process that will run the prompt.
 *
 * @param input - The unresolved input.
 * @param resolver - Creates the run's resource instances, for `instance`
 *   references. Without one, an `instance` reference fails.
 * @param context - The row and bindings `dataset` and `input` references
 *   resolve against. See {@link ResolutionContext}.
 */
export function resolveExecutionInput(
  input: ExecutionInput,
  resolver?: InstanceResolver,
  context?: ResolutionContext,
): Promise<unknown> {
  return resolveWithin(input, resolver, context ?? {}, []);
}

/**
 * {@link resolveExecutionInput}, carrying the chain of `input` references
 * being followed — the runtime backstop for a cycle the static check
 * ({@link findInputCycle}) couldn't see, one assembled from dataset cells.
 */
async function resolveWithin(
  input: ExecutionInput,
  resolver: InstanceResolver | undefined,
  context: ResolutionContext,
  chain: readonly string[],
): Promise<unknown> {
  const recurse = (child: ExecutionInput, nextChain = chain) =>
    resolveWithin(child, resolver, context, nextChain);

  switch (input.kind) {
    case "value":
      return materializeValue(input.value);

    case "object": {
      const entries = await Promise.all(
        Object.entries(input.properties).map(
          async ([k, v]) => [k, await recurse(v)] as const,
        ),
      );
      return Object.fromEntries(entries);
    }

    case "instance": {
      if (!resolver) {
        throw new Error(
          `Cannot resolve resource '${input.name}': this provider does not offer resources.`,
        );
      }
      return resolver.acquire(input.name, input.output);
    }

    case "dataset": {
      if (!context.row) {
        throw new Error(
          `Column '${input.field}' can only be bound in an eval run, which runs a dataset row.`,
        );
      }
      const cell = context.row.cells[input.field];
      return cell === undefined ? undefined : recurse(cell);
    }

    case "input": {
      if (!context.bindings) {
        throw new Error(
          `Input '${input.path}' names another slot, but this run has no slot bindings to read it from.`,
        );
      }
      const key = inputKey(input.half, input.path);
      if (chain.includes(key)) {
        throw new Error(`Input cycle: ${[...chain, key].join(" → ")}`);
      }
      const { node, rest } = bindingAt(
        context.bindings,
        input.half,
        input.path,
      );
      if (!node) return undefined;
      return readPath(await recurse(node, [...chain, key]), rest);
    }
  }
}

/**
 * Resolve a whole execute request's inputs.
 *
 * The run's named resource instances (`inputs.resources`) are declared to
 * `resolver` and **all** created first — whether or not any slot names
 * them, which is what lets an instance exist purely for its side effects
 * (`specs/resource-instances.md` §B). Each instance's arguments resolve
 * under the same `context`, so they may name another instance's output,
 * another slot, or a dataset cell. Slots then resolve, and an `instance`
 * reference among them gets the instance already created.
 *
 * @param context - What `dataset` and `input` references resolve against.
 */
export async function resolveExecutionInputs(
  inputs: {
    functionInputs?: readonly ExecutionInput[];
    executeInputs?: Record<string, ExecutionInput>;
    resources?: RunResources;
  },
  resolver?: InstanceResolver,
  context?: ResolutionContext,
): Promise<{ functionParams: any[]; executeValues: Record<string, any> }> {
  const resources = Object.entries(inputs.resources ?? {});
  if (resources.length > 0) {
    if (!resolver) {
      throw new Error(
        `Cannot create resource '${resources[0][0]}': this provider does not offer resources.`,
      );
    }
    await resolver.declare(
      Object.fromEntries(
        resources.map(([name, spec]) => [
          name,
          declaredInstance(spec, resolver, context),
        ]),
      ),
    );
    await Promise.all(resources.map(([name]) => resolver.acquire(name)));
  }

  const functionParams = await Promise.all(
    (inputs.functionInputs ?? []).map(i =>
      resolveExecutionInput(i, resolver, context),
    ),
  );

  const executeEntries = await Promise.all(
    Object.entries(inputs.executeInputs ?? {}).map(
      async ([name, input]) =>
        [name, await resolveExecutionInput(input, resolver, context)] as const,
    ),
  );

  return {
    functionParams,
    executeValues: Object.fromEntries(executeEntries),
  };
}

/**
 * What the lease is told about one instance: its arguments as a thunk —
 * resolved only once the instance is actually created, under the run's own
 * context — and its replay receipt.
 */
function declaredInstance(
  spec: RunResources[string],
  resolver: InstanceResolver,
  context: ResolutionContext | undefined,
): DeclaredInstance {
  const args = Object.entries(spec.args ?? {});
  if (args.length === 0 && spec.receipt === undefined) return { uri: spec.uri };
  return {
    uri: spec.uri,
    binding: {
      ...(args.length > 0 && {
        resolve: async () =>
          Object.fromEntries(
            await Promise.all(
              args.map(
                async ([k, v]) =>
                  [k, await resolveExecutionInput(v, resolver, context)] as const,
              ),
            ),
          ),
      }),
      ...(spec.receipt !== undefined && { receipt: spec.receipt }),
    },
  };
}

/**
 * Returns `resources` with each instance's `receipt` set from `receipts` —
 * the by-name shape `ResourceLease.receipts()` produces — so the inputs
 * recorded on a trace carry what this run's resources actually produced. An
 * incoming receipt (a replay's) never outlives a run whose `create` didn't
 * produce one. See `specs/resource-arguments.md` §K.
 *
 * @param resources - The instances a request was sent with.
 * @param receipts - What the run's resolution produced, if anything did.
 */
export function stampReceipts(
  resources: RunResources | undefined,
  receipts: Record<string, unknown> | undefined,
): RunResources | undefined {
  if (!resources) return undefined;
  return Object.fromEntries(
    Object.entries(resources).map(([name, { receipt: _, ...spec }]) => {
      const receipt = receipts?.[name];
      return [name, receipt === undefined ? spec : { ...spec, receipt }];
    }),
  );
}
