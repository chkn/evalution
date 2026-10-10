// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A prompt's slots, and the `input` references between them — the pure part
 * of `src/prompt/execution-inputs.ts`, shared with the client so the eval
 * editor lists the same problems the server refuses. See `specs/evals.md`
 * §B.2.
 */

import type {
  ExecutionInput,
  PropDefinition,
  PropType,
  RunResources,
} from "./types.ts";

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
 * A run's complete set of slot bindings, by slot name — what an `input`
 * reference looks its target up in. The execute panel's own request is one
 * (see {@link namedBindings}); so is an eval's `inputs`.
 */
export interface InputBindings {
  /** Function parameter name → its binding. */
  functionInputs: Record<string, ExecutionInput>;
  /** Execute parameter name → its binding. */
  executeInputs: Record<string, ExecutionInput>;
  /**
   * The run's named resource instances, whose arguments may themselves hold
   * `input` and `instance` references. See `specs/resource-instances.md`.
   */
  resources?: RunResources;
}

/** An `input` reference's target, as one string: `execute:` prefixed for an execute slot. */
export function inputKey(half: "function" | "execute", path: string): string {
  return half === "execute" ? `execute:${path}` : path;
}

/**
 * Names a positional request's function inputs by parameter, so an `input`
 * reference can look them up: the execute panel's request, read as the set
 * of bindings it is (`specs/evals.md` §B.2.1).
 *
 * @param functionParameters - The prompt's parameters, in order.
 * @param inputs - The request, positional as the execute route takes it.
 */
export function namedBindings(
  functionParameters: readonly Pick<PropDefinition, "name">[],
  inputs: {
    functionInputs?: readonly ExecutionInput[];
    executeInputs?: Record<string, ExecutionInput>;
    resources?: RunResources;
  },
): InputBindings {
  const functionInputs: Record<string, ExecutionInput> = {};
  functionParameters.forEach((param, i) => {
    const input = inputs.functionInputs?.[i];
    if (input) functionInputs[param.name] = input;
  });
  return {
    functionInputs,
    executeInputs: { ...inputs.executeInputs },
    ...(inputs.resources && { resources: inputs.resources }),
  };
}

/**
 * Somewhere a reference can sit, or point: a slot (or a path within one), or
 * one of the run's resource instances (whose arguments count as the
 * instance itself).
 */
type RefLocation =
  | { half: "function" | "execute"; path: string }
  | { instance: string };

/** One `input` or `instance` reference found in a set of bindings, and where it sits. */
interface FoundRef {
  /** Where the reference sits. */
  at: RefLocation;
  /** What it names. */
  target: RefLocation;
}

/** How a {@link RefLocation} reads in a message: a slot as {@link inputKey}, an instance as `resource 'name'`. */
function locationKey(loc: RefLocation): string {
  return "instance" in loc
    ? `resource '${loc.instance}'`
    : inputKey(loc.half, loc.path);
}

/** The input kinds a run can resolve; anything else is refused up front. */
const KNOWN_KINDS: ReadonlySet<string> = new Set(
  Object.keys({
    value: true,
    object: true,
    input: true,
    instance: true,
    dataset: true,
  } satisfies Record<ExecutionInput["kind"], true>),
);

/** Every instance name `input` references, at any depth. */
export function instanceNames(input: ExecutionInput): string[] {
  switch (input.kind) {
    case "instance":
      return [input.name];
    case "object":
      return Object.values(input.properties).flatMap(instanceNames);
    default:
      return [];
  }
}

/**
 * Every `input` and `instance` reference inside `bindings`, with where it
 * sits. A node of a kind no run can resolve — the removed inline `resource`
 * — goes to `unsupported`, when given.
 */
function findRefs(
  bindings: InputBindings,
  unsupported?: { at: RefLocation; kind: string }[],
): FoundRef[] {
  const found: FoundRef[] = [];
  const walk = (node: ExecutionInput, at: RefLocation) => {
    switch (node.kind) {
      case "object":
        for (const [k, child] of Object.entries(node.properties)) {
          walk(
            child,
            "instance" in at ? at : { half: at.half, path: `${at.path}.${k}` },
          );
        }
        break;
      case "input":
        found.push({ at, target: { half: node.half, path: node.path } });
        break;
      case "instance":
        found.push({ at, target: { instance: node.name } });
        break;
      default:
        if (!KNOWN_KINDS.has(node.kind)) {
          unsupported?.push({ at, kind: (node as { kind: string }).kind });
        }
        break;
    }
  };
  for (const [name, node] of Object.entries(bindings.functionInputs)) {
    walk(node, { half: "function", path: name });
  }
  for (const [name, node] of Object.entries(bindings.executeInputs)) {
    walk(node, { half: "execute", path: name });
  }
  for (const [name, spec] of Object.entries(bindings.resources ?? {})) {
    // Arguments are resolved as part of creating the instance, so a
    // reference among them sits at the instance itself, however deep.
    for (const arg of Object.values(spec.args ?? {})) {
      walk(arg, { instance: name });
    }
  }
  return found;
}

/** Whether resolving whatever sits at `at` means resolving `target` first. */
function reaches(at: RefLocation, target: RefLocation): boolean {
  if ("instance" in at || "instance" in target) {
    return (
      "instance" in at &&
      "instance" in target &&
      at.instance === target.instance
    );
  }
  return at.half === target.half && overlaps(at.path, target.path);
}

/** Whether one dotted path is the other, or contains it. */
export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * A cycle among `bindings`' `input` and `instance` references — `a` ← input
 * `b` ← input `a`, or two resource instances each taking the other's output
 * as an argument — as the places that form it, first repeated last; or
 * `undefined` when there is none. Resolving a slot means resolving every
 * reference that sits inside it or around it, and creating an instance means
 * resolving every reference among its arguments, which is what an edge here
 * is. See `specs/evals.md` §B.2 and `specs/resource-instances.md` §B.
 */
export function findInputCycle(bindings: InputBindings): string[] | undefined {
  const refs = findRefs(bindings);
  const edges = refs.map(ref =>
    refs.filter(other => reaches(other.at, ref.target)),
  );
  const state = new Map<FoundRef, "visiting" | "done">();
  const stack: FoundRef[] = [];

  const visit = (ref: FoundRef): string[] | undefined => {
    const seen = state.get(ref);
    if (seen === "done") return undefined;
    if (seen === "visiting") {
      const loop = stack.slice(stack.indexOf(ref));
      return [...loop, ref].map(r => locationKey(r.at));
    }
    state.set(ref, "visiting");
    stack.push(ref);
    for (const next of edges[refs.indexOf(ref)]) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(ref, "done");
    return undefined;
  };

  for (const ref of refs) {
    const cycle = visit(ref);
    if (cycle) return cycle;
  }
  return undefined;
}

/** A prompt's parameters, as far as `input` references care. */
export interface InputSignature {
  functionParameters: readonly PropDefinition[];
  executeParameters?: readonly PropDefinition[];
}

/** Every slot path an `input` reference into `signature` can name, by half. */
export function slotPaths(
  signature: InputSignature,
): Record<"function" | "execute", Set<string>> {
  return {
    function: new Set(
      collectInputSlots(signature.functionParameters).map(s => s.path),
    ),
    execute: new Set(
      collectInputSlots(signature.executeParameters ?? []).map(s => s.path),
    ),
  };
}

/**
 * What's wrong with `bindings`' `input` and `instance` references against a
 * prompt's signature: a target slot that doesn't exist, a resource instance
 * the run doesn't declare, and a cycle. Empty when nothing is. The execute
 * route answers a non-empty list with a 400, and an eval run refuses to
 * start. See `specs/evals.md` §B.2.1.
 *
 * @param options.undeclaredInstances - Allow `instance` references to names
 *   `bindings.resources` doesn't declare — an eval's, which each dataset row
 *   may declare instead (`specs/resource-instances.md` §E).
 */
export function inputReferenceProblems(
  bindings: InputBindings,
  signature: InputSignature,
  options: { undeclaredInstances?: boolean } = {},
): string[] {
  const slots = slotPaths(signature);
  const instances = bindings.resources ?? {};
  const problems: string[] = [];
  const unsupported: { at: RefLocation; kind: string }[] = [];
  const refs = findRefs(bindings, unsupported);
  const where = (loc: RefLocation) =>
    "instance" in loc ? locationKey(loc) : `'${locationKey(loc)}'`;
  for (const { at, kind } of unsupported) {
    problems.push(
      kind === "resource"
        ? `${where(at)} uses an inline 'resource' input, which is no longer supported: declare the resource in 'resources' and reference it with { kind: "instance" }`
        : `${where(at)} has an input of unknown kind '${kind}'`,
    );
  }
  for (const ref of refs) {
    const at = where(ref.at);
    if ("instance" in ref.target) {
      if (
        !options.undeclaredInstances &&
        !Object.hasOwn(instances, ref.target.instance)
      ) {
        problems.push(
          `${at} names resource '${ref.target.instance}', which this run doesn't declare`,
        );
      }
    } else if (!slots[ref.target.half].has(ref.target.path)) {
      problems.push(
        `${at} names input '${inputKey(ref.target.half, ref.target.path)}', which the prompt doesn't have`,
      );
    }
  }
  const cycle = findInputCycle(bindings);
  if (cycle) problems.push(`Input cycle: ${cycle.join(" → ")}`);
  return problems;
}
