// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropDefinition, PropValue, ValueFactory } from "ts-proppy";
import { defaultCall, renameRecordKey } from "ts-proppy/react";

/** The questions of a `questions` value, or `undefined` if it isn't an object literal. */
export function questionEntries(
  value: PropValue | undefined,
): Record<string, PropValue> | undefined {
  if (value === undefined) return {};
  return value.kind === "object" ? value.properties : undefined;
}

/** The definition each question is edited against, if `def` is a record. */
export function questionDefinition(
  def: PropDefinition,
): PropDefinition | undefined {
  return def.type.kind === "record" ? def.type.value : undefined;
}

/**
 * A fresh question id: `question_1`, `question_2`, … — the first not already
 * taken. Ids are keys the user will rename, so they only need to be unique and
 * a valid identifier (so the source stays unquoted).
 */
export function mintQuestionId(
  existing: Readonly<Record<string, unknown>>,
): string {
  const taken = new Set(Object.keys(existing));
  for (let n = Object.keys(existing).length + 1; ; n++) {
    const id = `question_${n}`;
    if (!taken.has(id)) return id;
  }
}

/** `questions` with a new question built by `factory` appended under a fresh id. */
export function addQuestion(
  questions: Readonly<Record<string, PropValue>>,
  factory: ValueFactory,
): { id: string; questions: Record<string, PropValue> } {
  const id = mintQuestionId(questions);
  return { id, questions: { ...questions, [id]: defaultCall(factory) } };
}

/** `questions` with `id` renamed in place. */
export function renameQuestion(
  questions: Readonly<Record<string, PropValue>>,
  id: string,
  next: string,
): Record<string, PropValue> {
  return renameRecordKey(questions, id, next);
}
