// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What the "＋" field popover offers and sends: the types a field can be
 * given — a primitive, or the type of a prompt parameter — and the request
 * body each one becomes. Pure; no React. See `specs/datasets.md` §P.1.
 */

import {
  type AddDatasetFieldRequest,
  isPrimitiveFieldType,
  type PrimitiveFieldType,
  samePrompt,
} from "../../shared/dataset-fields";
import type { NormalizedPrompt, PropDefinition } from "../../shared/types";

/** A prompt parameter whose type a new field can copy. */
export interface ParameterOption {
  /** Unique among the options — the picker's `<option>` value. */
  value: string;
  providerId: string;
  promptId: string;
  /** Which of the prompt's parameter lists it's in. */
  half: "function" | "execute";
  /** The parameter's name, which is also its slot path. */
  path: string;
  def: PropDefinition;
}

/** One prompt's parameters, as a group in the picker. */
export interface ParameterOptionGroup {
  /** Unique among the groups: the prompt's provider and id. */
  key: string;
  /** The prompt's display name. */
  label: string;
  /** Whether this is the dataset's linked prompt, which is listed first. */
  linked: boolean;
  options: ParameterOption[];
}

/**
 * Every loaded prompt's parameters, grouped by prompt: the dataset's linked
 * prompt first, then the rest in the order given. Function parameters come
 * before execute parameters, as the panel shows them; a prompt with neither
 * is left out.
 */
export function parameterOptionGroups(
  prompts: readonly NormalizedPrompt[],
  linked?: Pick<NormalizedPrompt, "id" | "providerId">,
): ParameterOptionGroup[] {
  const groups: ParameterOptionGroup[] = [];
  for (const prompt of prompts) {
    if (!prompt.providerId) continue;
    const { providerId, id: promptId } = prompt;
    const option = (
      half: ParameterOption["half"],
      def: PropDefinition,
    ): ParameterOption => ({
      value: JSON.stringify([providerId, promptId, half, def.name]),
      providerId,
      promptId,
      half,
      path: def.name,
      def,
    });
    const options = [
      ...prompt.functionParameters.map(def => option("function", def)),
      ...(prompt.executeParameters ?? []).map(def => option("execute", def)),
    ];
    if (options.length === 0) continue;
    const isLinked = samePrompt(prompt, linked);
    groups.push({
      key: JSON.stringify([providerId, promptId]),
      label: prompt.name,
      linked: isLinked,
      options,
    });
  }
  // Stable, so the rest keep their order.
  return groups.sort((a, b) => Number(b.linked) - Number(a.linked));
}

/** What the picker has chosen: a primitive type, or a parameter's type. */
export type FieldTypeChoice =
  | { kind: "primitive"; type: PrimitiveFieldType }
  | { kind: "parameter"; option: ParameterOption };

/**
 * The picker value `value` names among `groups`: a primitive type's name, or
 * a {@link ParameterOption.value}. `undefined` for anything else.
 */
export function choiceFor(
  value: string,
  groups: readonly ParameterOptionGroup[],
): FieldTypeChoice | undefined {
  if (isPrimitiveFieldType(value)) return { kind: "primitive", type: value };
  for (const group of groups) {
    const option = group.options.find(o => o.value === value);
    if (option) return { kind: "parameter", option };
  }
  return undefined;
}

/**
 * The name a new field gets when the name box is left empty: a parameter's
 * own name, or none for a primitive, which has to be named.
 */
export function defaultFieldName(choice: FieldTypeChoice): string {
  return choice.kind === "parameter" ? choice.option.def.name : "";
}

/**
 * The `POST …/fields` body for `name` and `choice`, or `undefined` when it
 * can't be sent yet (a primitive with no name). A parameter is sent as a
 * reference for the server to look up — never as its definition.
 */
export function addFieldRequest(
  name: string,
  choice: FieldTypeChoice,
): AddDatasetFieldRequest | undefined {
  const trimmed = name.trim();
  if (choice.kind === "primitive") {
    return trimmed ? { name: trimmed, type: choice.type } : undefined;
  }
  const { providerId, promptId, half, path } = choice.option;
  return {
    from: { providerId, promptId, half, path },
    ...(trimmed && trimmed !== choice.option.def.name && { name: trimmed }),
  };
}
