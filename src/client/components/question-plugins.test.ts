// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { getDiscriminatedUnionInfo, type PropDefinition } from "ts-proppy";
import { describe, expect, it } from "vitest";
import { TYPESAFE_FALLBACK } from "../../sdk/typesafe-sdk/fallback.ts";
import { VERCEL_EVALUATION_FALLBACK } from "../../sdk/vercel-ai-sdk/evaluation-fallback.ts";
import {
  entryMembers,
  isNullableEntryRecord,
  scoreLevelSlots,
} from "./question-plugins";

/** A property of one case of the AI SDK's question union, as `ai` types it. */
function aiQuestionProperty(kind: string, name: string): PropDefinition {
  const questions =
    VERCEL_EVALUATION_FALLBACK.evaluationQuestions as PropDefinition;
  if (questions.type.kind !== "record") throw new Error("not a record");
  const union = getDiscriminatedUnionInfo(questions.type.value.type)!;
  const c = union.cases.find(c => c.discriminatorValue === kind)!;
  return c.properties.find(p => p.name === name)!;
}

describe("entryMembers", () => {
  it("recognizes the AI SDK's evaluation input as an entry", () => {
    const state = VERCEL_EVALUATION_FALLBACK.evaluationState as PropDefinition;
    expect(entryMembers(state.type)).toBeDefined();
    expect(
      entryMembers(aiQuestionProperty("choice", "instructions").type),
    ).toBeDefined();
  });

  it("recognizes TypeSafe's", () => {
    const state = TYPESAFE_FALLBACK.state as PropDefinition;
    expect(entryMembers(state.type)).toBeDefined();
  });
});

describe("scoreLevelSlots", () => {
  it("reads the AI SDK's score criteria as a list of at least two levels", () => {
    const criteria = aiQuestionProperty("score", "criteria");
    const slots = scoreLevelSlots(criteria.type, [
      "questions",
      "q",
      "criteria",
    ]);
    expect(slots).toMatchObject({ fixed: [], min: 2 });
    expect(entryMembers(slots!.rest.type)).toBeDefined();
  });

  it("only treats an array as levels at a criteria slot", () => {
    const criteria = aiQuestionProperty("score", "criteria");
    expect(scoreLevelSlots(criteria.type, ["state", "tags"])).toBeUndefined();
  });

  it("reads a variadic tuple of entries as levels, fixing its leading ones", () => {
    const entry = aiQuestionProperty("score", "criteria");
    if (entry.type.kind !== "array") throw new Error("not an array");
    const level = entry.type.element;
    const slots = scoreLevelSlots(
      { kind: "tuple", syntax: "", elements: [level, level], rest: level },
      [],
    );
    expect(slots).toMatchObject({ min: 2 });
    expect(slots?.fixed).toHaveLength(2);
  });

  it("leaves other arrays alone", () => {
    expect(
      scoreLevelSlots(
        {
          kind: "array",
          syntax: "number[]",
          element: {
            name: "",
            optional: false,
            type: { kind: "primitive", syntax: "number", base: "number" },
          },
        },
        ["criteria"],
      ),
    ).toBeUndefined();
  });
});

/** A parameter of one of TypeSafe's question factories. */
function typeSafeParameter(factory: string, name: string): PropDefinition {
  const found = (TYPESAFE_FALLBACK.questionFactories as any[]).find(
    f => f.def.name === factory,
  );
  return found.def.type.parameters.find((p: PropDefinition) => p.name === name);
}

describe("nullable entries", () => {
  it("reports whether an entry may be null", () => {
    expect(
      entryMembers(aiQuestionProperty("choice", "instructions").type)?.nullable,
    ).toBe(false);
    const criteria = aiQuestionProperty("choice", "criteria").type;
    if (criteria.kind !== "record") throw new Error("not a record");
    expect(entryMembers(criteria.value.type)?.nullable).toBe(true);
  });

  it("recognizes both SDKs' choice criteria as records of nullable entries", () => {
    expect(
      isNullableEntryRecord(aiQuestionProperty("choice", "criteria").type),
    ).toBe(true);
    expect(
      isNullableEntryRecord(typeSafeParameter("choice", "criteria").type),
    ).toBe(true);
  });

  it("leaves a state's JSON object alone, whose values aren't entries", () => {
    const state = VERCEL_EVALUATION_FALLBACK.evaluationState as PropDefinition;
    if (state.type.kind !== "union") throw new Error("not a union");
    const record = state.type.types.find(t => t.kind === "record")!;
    expect(isNullableEntryRecord(record)).toBe(false);
  });
});
