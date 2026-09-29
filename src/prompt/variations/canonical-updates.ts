// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Pure helpers that give a {@link NormalizedPromptUpdates} one spelling per
 * meaning, so variations dedupe and "is it dirty?" tells the truth. See
 * `specs/prompt-versions-and-variations.md` §E.1.
 */

import type {
  NormalizedPrompt,
  NormalizedPromptUpdates,
} from "../../shared/types.ts";

/** Prefix of a per-parameter field name, e.g. `modelParameters.temperature`. */
const MODEL_PARAMETER_PREFIX = "modelParameters.";

/**
 * The fields a set of updates sets, as `[field, value]` pairs: `model`,
 * `system`, `messages`, `state`, `questions`, and one
 * `modelParameters.<name>` per model parameter. `null` means "remove".
 */
export function updateFields(
  updates: NormalizedPromptUpdates,
): [field: string, value: unknown][] {
  const fields: [string, unknown][] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (key === "style" || value === undefined) continue;
    if (key === "modelParameters") {
      for (const [name, param] of Object.entries(
        (value ?? {}) as Record<string, unknown>,
      )) {
        if (param !== undefined) {
          fields.push([`${MODEL_PARAMETER_PREFIX}${name}`, param]);
        }
      }
    } else {
      fields.push([key, value]);
    }
  }
  return fields;
}

/**
 * The value `prompt` currently has for `field` (see {@link updateFields}), or
 * `undefined` when it has none.
 */
export function promptFieldValue(
  prompt: NormalizedPrompt,
  field: string,
): unknown {
  if (field.startsWith(MODEL_PARAMETER_PREFIX)) {
    const name = field.slice(MODEL_PARAMETER_PREFIX.length);
    return prompt.modelParameters.find(p => p.def.name === name)?.value;
  }
  switch (field) {
    case "model":
      return prompt.model;
    case "system":
      return prompt.style === "chat" ? prompt.system : undefined;
    case "messages":
      return prompt.style === "chat" ? prompt.messages : undefined;
    case "state":
      return prompt.style === "questions" ? prompt.state.value : undefined;
    case "questions":
      return prompt.style === "questions" ? prompt.questions.value : undefined;
    default:
      return undefined;
  }
}

/** A copy of `updates` with `field` set to `value`. */
export function withField(
  updates: NormalizedPromptUpdates,
  field: string,
  value: unknown,
): NormalizedPromptUpdates {
  if (field.startsWith(MODEL_PARAMETER_PREFIX)) {
    const name = field.slice(MODEL_PARAMETER_PREFIX.length);
    return {
      ...updates,
      modelParameters: { ...updates.modelParameters, [name]: value as any },
    };
  }
  return { ...updates, [field]: value } as NormalizedPromptUpdates;
}

/** A copy of `updates` without `field`. */
export function withoutField(
  updates: NormalizedPromptUpdates,
  field: string,
): NormalizedPromptUpdates {
  if (field.startsWith(MODEL_PARAMETER_PREFIX)) {
    const name = field.slice(MODEL_PARAMETER_PREFIX.length);
    const { [name]: _, ...rest } = updates.modelParameters ?? {};
    if (Object.keys(rest).length > 0) {
      return { ...updates, modelParameters: rest };
    }
    const { modelParameters: _params, ...next } = updates;
    return next as NormalizedPromptUpdates;
  }
  const next = { ...updates } as Record<string, unknown>;
  delete next[field];
  return next as unknown as NormalizedPromptUpdates;
}

/**
 * Updates that set every field to `prompt`'s value — `null` for one it
 * doesn't have — so applying them anywhere reproduces `prompt`'s fields.
 * Canonicalize against the target to keep only what differs.
 */
export function fieldUpdatesOf(
  prompt: NormalizedPrompt,
): NormalizedPromptUpdates {
  const modelParameters = Object.fromEntries(
    prompt.modelParameters.map(p => [p.def.name, p.value ?? null]),
  );
  const common = {
    model: prompt.model ?? null,
    ...(Object.keys(modelParameters).length > 0 && { modelParameters }),
  };
  return prompt.style === "chat"
    ? {
        style: "chat",
        ...common,
        system: prompt.system ?? null,
        messages: prompt.messages.length > 0 ? prompt.messages : null,
      }
    : {
        style: "questions",
        ...common,
        state: prompt.state.value ?? null,
        questions: prompt.questions.value ?? null,
      };
}

/** Whether `updates` set nothing at all. */
export function isEmptyUpdates(updates: NormalizedPromptUpdates): boolean {
  return updateFields(updates).length === 0;
}

/** Updates that set nothing, in `style`. */
export function emptyUpdates(
  style: NormalizedPromptUpdates["style"],
): NormalizedPromptUpdates {
  return { style } as NormalizedPromptUpdates;
}

/**
 * Folds successive edits into one: later fields win, `modelParameters` merges
 * per key, and `null` (remove) is kept as a value. The result takes the last
 * set's style; sets of another style than the last are dropped, since their
 * fields don't mean anything in it.
 */
export function mergeUpdates(
  ...sets: (NormalizedPromptUpdates | undefined)[]
): NormalizedPromptUpdates {
  const present = sets.filter((s): s is NormalizedPromptUpdates => !!s);
  const style = present.at(-1)?.style ?? "chat";
  let merged = emptyUpdates(style);
  for (const set of present) {
    if (set.style !== style) continue;
    for (const [field, value] of updateFields(set)) {
      merged = withField(merged, field, value);
    }
  }
  return merged;
}

/**
 * `value` in the form two values are compared in: display-only details
 * (`displayValue`, and the import candidates a catalog value carries) are
 * dropped, a template with no interpolation is the plain string it spells,
 * and an empty message list is no message list.
 */
function comparable(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : value.map(comparableNode);
  }
  return comparableNode(value);
}

function comparableNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparableNode);
  if (!value || typeof value !== "object") return value;

  const node = value as Record<string, unknown>;
  if (typeof node.kind === "string") {
    if (node.kind === "template" && Array.isArray(node.value)) {
      const segments = mergeTemplateSegments(node.value);
      if (segments.every(s => typeof s === "string")) {
        return { kind: "primitive", value: segments.join("") };
      }
      return { kind: "template", value: segments.map(comparableNode) };
    }
    const { displayValue: _, ...rest } = node;
    // A call's `binding` says where its callee is imported from — a single
    // import once parsed, a list of candidates while it's still a catalog
    // preset. Either way it's the same call.
    if (node.kind === "functionCall") delete rest.binding;
    return mapValues(rest);
  }
  return mapValues(node);
}

function mapValues(node: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(node)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, comparableNode(v)]),
  );
}

/** Adjacent literal segments joined, empty ones dropped. */
function mergeTemplateSegments(segments: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const segment of segments) {
    if (typeof segment === "string") {
      if (segment === "") continue;
      if (typeof out.at(-1) === "string") {
        out[out.length - 1] = (out.at(-1) as string) + segment;
        continue;
      }
    }
    out.push(segment);
  }
  return out;
}

/**
 * Whether two field values mean the same thing. `null` (remove) and
 * `undefined` (absent) are the same.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableStringify(comparable(a)) === stableStringify(comparable(b));
}

/**
 * JSON with object keys sorted and `undefined` properties dropped, so equal
 * values always produce equal bytes.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => [k, sortKeys((value as Record<string, unknown>)[k])]),
  );
}

/** `value` without any `displayValue`: it is re-derived from source on every parse. */
function withoutDisplayValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDisplayValues);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(node)
      .filter(
        ([k, v]) =>
          v !== undefined && !(k === "displayValue" && "kind" in node),
      )
      .map(([k, v]) => [k, withoutDisplayValues(v)]),
  );
}

/**
 * The one spelling of `updates` against `base`:
 *
 * - **Minimized against the base.** A field equal to the base's value is
 *   dropped, so edit-then-undo leaves nothing.
 * - **Stripped of display-only detail** (`displayValue`), which the next
 *   parse re-derives anyway.
 *
 * Serialize the result with {@link serializeUpdates} for sorted keys and no
 * insignificant whitespace. Updates of another style than `base`'s are
 * returned unminimized: none of their fields line up with the base's.
 */
export function canonicalizeUpdates(
  base: NormalizedPrompt,
  updates: NormalizedPromptUpdates,
): NormalizedPromptUpdates {
  let result = emptyUpdates(updates.style);
  for (const [field, value] of updateFields(updates)) {
    if (
      base.style === updates.style &&
      sameValue(promptFieldValue(base, field), value)
    ) {
      continue;
    }
    result = withField(result, field, withoutDisplayValues(value));
  }
  return result;
}

/** The canonical bytes of `updates` — what a variation row stores and dedupes on. */
export function serializeUpdates(updates: NormalizedPromptUpdates): string {
  return stableStringify(updates);
}
