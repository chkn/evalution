// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The bindings an eval is proposed so a dataset made from the prompt binds
 * without any clicking — in the eval editor, and for an agent creating an
 * eval over MCP. Pure. See `specs/evals.md` §F.1.
 */

import type { DatasetField } from "../dataset/dataset-types.ts";
import type { EvalCheck, EvalInputs } from "../eval/eval-types.ts";
import type {
  CheckInfo,
  ExecutionInput,
  PropDefinition,
  PropValue,
  RunResources,
} from "./types.ts";

/** What {@link prefillBindings} takes. */
export interface PrefillInput {
  prompt: {
    functionParameters: readonly PropDefinition[];
    executeParameters?: readonly PropDefinition[];
  };
  /** The dataset's fields. */
  fields: readonly Pick<DatasetField, "id" | "def">[];
  /** The eval's bindings so far. Never overwritten. */
  inputs: EvalInputs;
  checks: readonly EvalCheck[];
  /** The checks on offer, for their parameters. */
  checkInfos: readonly CheckInfo[];
  /**
   * What the playground last ran this prompt with — the execute panel's
   * persisted selection. Absent when it never has.
   */
  stored?: {
    functionInputs?: Record<string, ExecutionInput>;
    executeInputs?: Record<string, ExecutionInput>;
    /** The playground's resource instances, which its inputs may reference. */
    resources?: RunResources;
  };
}

/** What {@link prefillBindings} proposes. */
export interface Prefilled {
  inputs: EvalInputs;
  checks: EvalCheck[];
  /**
   * Where a binding was made for the user, so the editor can mark it
   * "matched" until it's touched: `fn:<path>`, `exec:<path>`, and
   * `check:<id>:<param>`.
   */
  matched: string[];
}

/** The field matching `def` by `datasets.md` §B's rule: name and syntax equal. */
function matchingField(
  def: PropDefinition,
  fields: PrefillInput["fields"],
): string | undefined {
  return fields.find(
    f => f.def.name === def.name && f.def.type.syntax === def.type.syntax,
  )?.id;
}

/** `stored`'s child `name`, where it has one to give. */
function storedChild(
  stored: ExecutionInput | undefined,
  name: string,
): ExecutionInput | undefined {
  if (stored?.kind === "object") return stored.properties[name];
  if (stored?.kind === "value" && stored.value.kind === "object") {
    const child: PropValue | undefined = stored.value.properties[name];
    return child && { kind: "value", value: child };
  }
  return undefined;
}

/**
 * One slot, filled where it's unbound: a matching column first, then what
 * the playground last ran. An object slot is filled property by property, as
 * the panel does, unless nothing in it matches a column — then the
 * playground's whole choice for it is kept together, resource chip and all.
 */
function fillSlot(
  def: PropDefinition,
  current: ExecutionInput | undefined,
  stored: ExecutionInput | undefined,
  fields: PrefillInput["fields"],
  path: string,
  matched: string[],
): ExecutionInput | undefined {
  if (current && current.kind !== "object") return current;
  if (!current) {
    const field = matchingField(def, fields);
    if (field) {
      matched.push(path);
      return { kind: "dataset", field };
    }
  }
  if (def.type.kind === "object") {
    const properties: Record<string, ExecutionInput> = {
      ...(current?.kind === "object" ? current.properties : {}),
    };
    const nested: string[] = [];
    for (const prop of def.type.properties) {
      const filled = fillSlot(
        prop,
        properties[prop.name],
        storedChild(stored, prop.name),
        fields,
        `${path}.${prop.name}`,
        nested,
      );
      if (filled) properties[prop.name] = filled;
    }
    const matchedColumn = nested.length > 0;
    if (!current && !matchedColumn && stored) {
      matched.push(path);
      return stored;
    }
    matched.push(...nested);
    if (Object.keys(properties).length === 0) return current;
    return { kind: "object", properties };
  }
  if (!current && stored) {
    matched.push(path);
    return stored;
  }
  return current;
}

/** Every instance name `input` references, at any depth. */
function instanceNames(input: ExecutionInput): string[] {
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
 * `own`, plus every instance of `stored` that the bindings (or those
 * instances' own arguments) reference and `own` doesn't already declare — so
 * a binding taken from what the playground last ran keeps the instance it
 * names. `undefined` when there are none.
 */
function withReferencedInstances(
  inputs: EvalInputs,
  own: RunResources | undefined,
  stored: RunResources | undefined,
): RunResources | undefined {
  const out: RunResources = { ...own };
  const pending = [
    ...Object.values(inputs.functionInputs),
    ...Object.values(inputs.executeInputs),
  ].flatMap(instanceNames);
  while (pending.length > 0) {
    const name = pending.pop()!;
    const spec = stored?.[name];
    if (Object.hasOwn(out, name) || !spec) continue;
    const { receipt: _, ...rest } = spec;
    out[name] = rest;
    pending.push(...Object.values(spec.args ?? {}).flatMap(instanceNames));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Proposes bindings for every unbound slot and check parameter, never
 * touching one already set (`specs/evals.md` §F.1):
 *
 * - A prompt slot takes a column that matches it by name and type, else
 *   what the playground last ran it with.
 * - A check parameter takes a matching column, else a prompt slot with the
 *   same name and type, as an `input` reference.
 *
 * Anything still unbound stays empty. It never guesses "the only resource
 * that fits": a confident wrong binding is worse than an obvious empty one.
 */
export function prefillBindings(input: PrefillInput): Prefilled {
  const { prompt, fields, stored } = input;
  const matched: string[] = [];

  const fillHalf = (
    params: readonly PropDefinition[],
    current: Record<string, ExecutionInput>,
    storedHalf: Record<string, ExecutionInput> | undefined,
    prefix: "fn" | "exec",
  ) => {
    const out = { ...current };
    for (const param of params) {
      const filled = fillSlot(
        param,
        current[param.name],
        storedHalf?.[param.name],
        fields,
        `${prefix}:${param.name}`,
        matched,
      );
      if (filled) out[param.name] = filled;
    }
    return out;
  };

  const inputs: EvalInputs = {
    functionInputs: fillHalf(
      prompt.functionParameters,
      input.inputs.functionInputs,
      stored?.functionInputs,
      "fn",
    ),
    executeInputs: fillHalf(
      prompt.executeParameters ?? [],
      input.inputs.executeInputs,
      stored?.executeInputs,
      "exec",
    ),
  };
  const resources = withReferencedInstances(
    inputs,
    input.inputs.resources,
    stored?.resources,
  );
  if (resources) inputs.resources = resources;

  const checks = input.checks.map(check => {
    const info = input.checkInfos.find(c => c.uri === check.uri);
    if (!info) return check;
    const args = { ...check.args };
    for (const param of info.parameters) {
      if (args[param.name]) continue;
      const field = matchingField(param, fields);
      if (field) {
        args[param.name] = { kind: "dataset", field };
        matched.push(`check:${check.id}:${param.name}`);
        continue;
      }
      const half = prompt.functionParameters.some(
        p => p.name === param.name && p.type.syntax === param.type.syntax,
      )
        ? "function"
        : (prompt.executeParameters ?? []).some(
              p => p.name === param.name && p.type.syntax === param.type.syntax,
            )
          ? "execute"
          : undefined;
      if (half) {
        args[param.name] = { kind: "input", half, path: param.name };
        matched.push(`check:${check.id}:${param.name}`);
      }
    }
    return { ...check, args };
  });

  return { inputs, checks, matched };
}
