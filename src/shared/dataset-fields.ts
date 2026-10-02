// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Dataset fields as both the client and the server see them: the §B matching
 * key, how a copied definition is made portable, and the wire shape of
 * adding a field by hand. Pure — no runtime dependencies. See
 * `specs/datasets.md` §B, §P.1.
 */

import type {
  DatasetField,
  NormalizedPrompt,
  PromptID,
  PropDefinition,
} from "./types.ts";

/**
 * The matching rule, and the only one: a source input and a target slot
 * match when their `name` is equal **and** their `type.syntax` is equal.
 * Plain string comparison over data the client already has — no checker —
 * and it fails closed. Also what makes a dataset's fields unique.
 */
export function matchKey(def: PropDefinition): string {
  return `${def.name}\u0000${def.type?.syntax ?? ""}`;
}

/**
 * A definition fit for a dataset schema: the file-specific source spans
 * dropped, since a dataset belongs to no file.
 */
export function portableDef(def: PropDefinition): PropDefinition {
  const { valueSpan: _v, fullSpan: _f, ...rest } = def;
  return rest;
}

/**
 * Whether `a` and `b` name the same prompt of the same provider. `false` when
 * either is missing.
 */
export function samePrompt(
  a: Pick<PromptID, "id" | "providerId"> | undefined,
  b: Pick<PromptID, "id" | "providerId"> | undefined,
): boolean {
  return !!a && !!b && a.id === b.id && a.providerId === b.providerId;
}

/** The types a field can be given by hand: the ones whose syntax is their structure. */
export const PRIMITIVE_FIELD_TYPES = ["string", "number", "boolean"] as const;

/** One of {@link PRIMITIVE_FIELD_TYPES}. */
export type PrimitiveFieldType = (typeof PRIMITIVE_FIELD_TYPES)[number];

/** Whether `value` is one of {@link PRIMITIVE_FIELD_TYPES}. */
export function isPrimitiveFieldType(
  value: unknown,
): value is PrimitiveFieldType {
  return PRIMITIVE_FIELD_TYPES.includes(value as PrimitiveFieldType);
}

/**
 * The body of `POST /api/datasets/:providerId/:id/fields`: a name and a
 * primitive type, or a prompt parameter for the server to copy the type of
 * (named after it unless `name` is given). Never a definition.
 */
export type AddDatasetFieldRequest =
  | { name: string; type: PrimitiveFieldType }
  | {
      from: {
        providerId: string;
        promptId: string;
        half?: "function" | "execute";
        path: string;
      };
      name?: string;
    };

/** Unique-by-{@link matchKey} fields for a set of definitions, in order. */
export function fieldsForDefs(
  defs: readonly PropDefinition[],
): Omit<DatasetField, "id">[] {
  const seen = new Set<string>();
  const out: Omit<DatasetField, "id">[] = [];
  for (const def of defs) {
    const key = matchKey(def);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ def: portableDef(def) });
  }
  return out;
}

/**
 * A schema for "New dataset" from a prompt's signature: every function and
 * execute parameter, filled or not — the dataset is *for* this prompt.
 */
export function fieldsForPrompt(
  prompt: NormalizedPrompt,
): Omit<DatasetField, "id">[] {
  return fieldsForDefs([
    ...prompt.functionParameters,
    ...(prompt.executeParameters ?? []),
  ]);
}
