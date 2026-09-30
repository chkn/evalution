// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A prompt's slots, and the `input` references between them — the pure part
 * of `src/prompt/execution-inputs.ts`, shared with the client so the eval
 * editor lists the same problems the server refuses. See `specs/evals.md`
 * §B.2.
 */

import type { ExecutionInput, PropDefinition, PropType } from "./types.ts";

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
  },
): InputBindings {
  const functionInputs: Record<string, ExecutionInput> = {};
  functionParameters.forEach((param, i) => {
    const input = inputs.functionInputs?.[i];
    if (input) functionInputs[param.name] = input;
  });
  return { functionInputs, executeInputs: { ...inputs.executeInputs } };
}

/** One `input` reference found in a set of bindings, and where it sits. */
interface FoundInputRef {
  /** The slot the reference sits in (a resource's arguments count as its own slot). */
  at: { half: "function" | "execute"; path: string };
  /** The slot it names. */
  target: { half: "function" | "execute"; path: string };
}

/** Every `input` reference inside `bindings`, with where it sits. */
function findInputRefs(bindings: InputBindings): FoundInputRef[] {
  const found: FoundInputRef[] = [];
  const walk = (
    node: ExecutionInput,
    half: "function" | "execute",
    path: string,
  ) => {
    switch (node.kind) {
      case "object":
        for (const [k, child] of Object.entries(node.properties)) {
          walk(child, half, `${path}.${k}`);
        }
        break;
      case "resource":
        // Arguments are resolved as part of this slot's own value, so a
        // reference among them sits here, however deep.
        for (const arg of Object.values(node.args ?? {})) walk(arg, half, path);
        break;
      case "input":
        found.push({
          at: { half, path },
          target: { half: node.half, path: node.path },
        });
        break;
      default:
        break;
    }
  };
  for (const [name, node] of Object.entries(bindings.functionInputs)) {
    walk(node, "function", name);
  }
  for (const [name, node] of Object.entries(bindings.executeInputs)) {
    walk(node, "execute", name);
  }
  return found;
}

/** Whether one dotted path is the other, or contains it. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * A cycle among `bindings`' `input` references — `a` ← input `b` ← input
 * `a` — as the slot paths that form it, first repeated last; or `undefined`
 * when there is none. Resolving a slot means resolving every reference that
 * sits inside it or around it, which is what an edge here is. See
 * `specs/evals.md` §B.2.
 */
export function findInputCycle(bindings: InputBindings): string[] | undefined {
  const refs = findInputRefs(bindings);
  const edges = refs.map(ref =>
    refs.filter(
      other =>
        other.at.half === ref.target.half &&
        overlaps(other.at.path, ref.target.path),
    ),
  );
  const state = new Map<FoundInputRef, "visiting" | "done">();
  const stack: FoundInputRef[] = [];

  const visit = (ref: FoundInputRef): string[] | undefined => {
    const seen = state.get(ref);
    if (seen === "done") return undefined;
    if (seen === "visiting") {
      const loop = stack.slice(stack.indexOf(ref));
      return [...loop, ref].map(r => inputKey(r.at.half, r.at.path));
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

/**
 * What's wrong with `bindings`' `input` references against a prompt's
 * signature: a target slot that doesn't exist, and a cycle. Empty when
 * nothing is. The execute route answers a non-empty list with a 400, and an
 * eval run refuses to start. See `specs/evals.md` §B.2.1.
 */
export function inputReferenceProblems(
  bindings: InputBindings,
  signature: {
    functionParameters: readonly PropDefinition[];
    executeParameters?: readonly PropDefinition[];
  },
): string[] {
  const slots = {
    function: new Set(
      collectInputSlots(signature.functionParameters).map(s => s.path),
    ),
    execute: new Set(
      collectInputSlots(signature.executeParameters ?? []).map(s => s.path),
    ),
  };
  const problems: string[] = [];
  for (const ref of findInputRefs(bindings)) {
    if (!slots[ref.target.half].has(ref.target.path)) {
      problems.push(
        `'${inputKey(ref.at.half, ref.at.path)}' names input '${inputKey(ref.target.half, ref.target.path)}', which the prompt doesn't have`,
      );
    }
  }
  const cycle = findInputCycle(bindings);
  if (cycle) problems.push(`Input cycle: ${cycle.join(" → ")}`);
  return problems;
}
