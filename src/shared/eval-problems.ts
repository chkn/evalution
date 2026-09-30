// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What stops an eval from running: the problems list the editor shows above
 * Run, and the one the runner refuses to start with. Pure, so both sides
 * list the same problems. See `specs/evals.md` §A and §F.
 */

import type { DatasetField } from "../dataset/dataset-types.ts";
import type { EvalCheck, EvalInputs } from "../eval/eval-types.ts";
import { inputKey, inputReferenceProblems } from "./input-references.ts";
import type { CheckInfo, ExecutionInput, PropDefinition } from "./types.ts";

/** What {@link evalProblems} checks an eval's bindings against. */
export interface EvalProblemsContext {
  /** The prompt's signature, when the prompt exists. */
  prompt?: {
    functionParameters: readonly PropDefinition[];
    executeParameters?: readonly PropDefinition[];
  };
  /** The dataset's fields, when the dataset exists. */
  fields?: readonly Pick<DatasetField, "id" | "def">[];
  /** The checks on offer. Omit to skip checking that each check exists. */
  checks?: readonly CheckInfo[];
}

/** Every column (`dataset` reference) inside `input`, at any depth. */
function columnRefs(input: ExecutionInput): string[] {
  switch (input.kind) {
    case "dataset":
      return [input.field];
    case "object":
      return Object.values(input.properties).flatMap(columnRefs);
    case "resource":
      return Object.values(input.args ?? {}).flatMap(columnRefs);
    default:
      return [];
  }
}

/** Every `input` reference inside `input`, at any depth. */
function slotRefs(
  input: ExecutionInput,
): Extract<ExecutionInput, { kind: "input" }>[] {
  switch (input.kind) {
    case "input":
      return [input];
    case "object":
      return Object.values(input.properties).flatMap(slotRefs);
    case "resource":
      return Object.values(input.args ?? {}).flatMap(slotRefs);
    default:
      return [];
  }
}

/**
 * The required slots of `params` that `bindings` leave unbound, as dotted
 * paths. An `object` binding is followed into the parameter's properties, as
 * the panel fills an object slot property by property.
 */
function unboundRequired(
  params: readonly PropDefinition[],
  bindings: Record<string, ExecutionInput>,
  prefix = "",
): string[] {
  const missing: string[] = [];
  for (const param of params) {
    const path = prefix ? `${prefix}.${param.name}` : param.name;
    const binding = bindings[param.name];
    if (!binding) {
      if (!param.optional) missing.push(path);
      continue;
    }
    if (binding.kind === "object" && param.type.kind === "object") {
      missing.push(
        ...unboundRequired(param.type.properties, binding.properties, path),
      );
    }
  }
  return missing;
}

/**
 * What's wrong with an eval's bindings, in the words the editor shows:
 *
 * - a required prompt slot or check parameter left unbound;
 * - a binding to a slot, column, or check that no longer exists;
 * - an `input` reference to a slot the prompt doesn't have, or a cycle.
 *
 * Empty when the eval can run. A half-bound eval is still a legitimate
 * draft: this gates Run, never Save.
 */
export function evalProblems(
  inputs: EvalInputs,
  checks: readonly EvalCheck[],
  context: EvalProblemsContext,
): string[] {
  const problems: string[] = [];
  const { prompt, fields } = context;
  const fieldIds = fields && new Set(fields.map(f => f.id));

  const missingColumns = (input: ExecutionInput, owner: string) => {
    if (!fieldIds) return;
    for (const field of columnRefs(input)) {
      if (!fieldIds.has(field)) {
        problems.push(`${owner} is bound to a column that no longer exists`);
      }
    }
  };

  const halves = [
    ["function", inputs.functionInputs, prompt?.functionParameters],
    ["execute", inputs.executeInputs, prompt?.executeParameters ?? []],
  ] as const;
  for (const [half, bindings, params] of halves) {
    for (const [name, binding] of Object.entries(bindings)) {
      const label = `Input '${inputKey(half, name)}'`;
      if (params && !params.some(p => p.name === name)) {
        problems.push(`${label} is bound, but the prompt no longer has it`);
        continue;
      }
      missingColumns(binding, label);
    }
    if (params) {
      for (const path of unboundRequired(params, bindings)) {
        problems.push(
          `Input '${inputKey(half, path)}' is required but unbound`,
        );
      }
    }
  }
  if (prompt) problems.push(...inputReferenceProblems(inputs, prompt));

  for (const check of checks) {
    const info = context.checks?.find(c => c.uri === check.uri);
    const label = `Check '${check.label ?? info?.label ?? check.uri}'`;
    if (context.checks && !info) {
      problems.push(`${label} no longer exists`);
      continue;
    }
    if (info?.error) {
      problems.push(`${label} can't load: ${info.error}`);
      continue;
    }
    for (const [name, binding] of Object.entries(check.args)) {
      const owner = `${label}: '${name}'`;
      missingColumns(binding, owner);
      if (!prompt) continue;
      for (const ref of slotRefs(binding)) {
        const params =
          ref.half === "function"
            ? prompt.functionParameters
            : (prompt.executeParameters ?? []);
        const root = ref.path.split(".")[0];
        if (!params.some(p => p.name === root)) {
          problems.push(
            `${owner} names input '${inputKey(ref.half, ref.path)}', which the prompt doesn't have`,
          );
        }
      }
    }
    if (info) {
      for (const path of unboundRequired(info.parameters, check.args)) {
        problems.push(`${label}: '${path}' is required but unbound`);
      }
    }
  }
  return problems;
}
