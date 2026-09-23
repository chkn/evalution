// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropDefinition, PropValue } from "ts-proppy";
import {
  defaultCall,
  defaultValueForType,
  getDiscriminatedUnionInfo,
  recordFactories,
  renameRecordKey,
} from "ts-proppy/react";

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

/** A kind of question the SDK offers, as the "Add question" menu lists it. */
export interface QuestionKind {
  /** Unique among the kinds offered. */
  key: string;
  label: string;
  /** A fresh question of this kind, to be filled in. */
  create: () => PropValue;
}

/** `choice` → `Choice`. */
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The kinds of question a `questions` record's value definition offers:
 *
 * - its catalog's **factories**, where the SDK builds questions with calls
 *   (TypeSafe's `choice(…)`), each a default call to fill in; or else
 * - the cases of its **discriminated union**, where questions are object
 *   literals (the AI SDK's `{ type: "choice", … }`), each an object with its
 *   discriminator set and its required properties defaulted.
 */
export function questionKinds(questionDef: PropDefinition): QuestionKind[] {
  const factories = recordFactories(questionDef);
  if (factories.length > 0) {
    return factories.map(({ label, factory }) => ({
      key: factory.def.name,
      label,
      create: () => defaultCall(factory),
    }));
  }
  const union = getDiscriminatedUnionInfo(questionDef.type);
  if (!union) return [];
  return union.cases.map(c => ({
    key: String(c.discriminatorValue),
    label: capitalize(String(c.discriminatorValue)),
    create: () => ({
      kind: "object",
      properties: {
        [union.discriminator]: {
          kind: "primitive",
          value: c.discriminatorValue,
        },
        ...Object.fromEntries(
          c.properties
            .filter(p => !p.optional)
            .map(p => [p.name, p.defaultValue ?? defaultValueForType(p.type)]),
        ),
      },
    }),
  }));
}

/** `questions` with a new question of `kind` appended under a fresh id. */
export function addQuestion(
  questions: Readonly<Record<string, PropValue>>,
  kind: QuestionKind,
): { id: string; questions: Record<string, PropValue> } {
  const id = mintQuestionId(questions);
  return { id, questions: { ...questions, [id]: kind.create() } };
}

/** `questions` with `id` renamed in place. */
export function renameQuestion(
  questions: Readonly<Record<string, PropValue>>,
  id: string,
  next: string,
): Record<string, PropValue> {
  return renameRecordKey(questions, id, next);
}
