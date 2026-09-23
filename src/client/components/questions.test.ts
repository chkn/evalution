// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropDefinition, PropValue, ValueFactory } from "ts-proppy";
import { describe, expect, it } from "vitest";
import {
  addQuestion,
  mintQuestionId,
  questionEntries,
  questionKinds,
  renameQuestion,
} from "./questions";

const noul: ValueFactory = {
  def: {
    name: "noul",
    optional: false,
    type: {
      kind: "function",
      syntax: "",
      parameters: [
        {
          name: "instructions",
          optional: true,
          type: { kind: "primitive", syntax: "string" },
        },
      ],
    },
  },
  binding: { kind: "import", spec: { name: "noul", from: "@typesafe-ai/sdk" } },
};

const q = (text: string): PropValue => ({
  kind: "functionCall",
  callee: "noul",
  args: [{ kind: "primitive", value: text }],
});

describe("mintQuestionId", () => {
  it("numbers from one past the number of questions", () => {
    expect(mintQuestionId({})).toBe("question_1");
    expect(mintQuestionId({ refund: q(""), team: q("") })).toBe("question_3");
  });

  it("skips ids that are already taken", () => {
    expect(mintQuestionId({ question_2: q(""), question_3: q("") })).toBe(
      "question_4",
    );
    expect(mintQuestionId({ a: q(""), question_2: q("") })).toBe("question_3");
  });
});

/** A record value definition whose catalog offers `noul`. */
const factoryQuestions: PropDefinition = {
  name: "",
  optional: false,
  type: { kind: "opaque", syntax: "Question" },
  catalogs: [
    { label: "Questions", groups: [{ label: "Yes / no", factory: noul }] },
  ],
};

const TEXT = { kind: "primitive", syntax: "string", base: "string" } as const;

/** The AI SDK's question union, cut down: questions are object literals. */
const unionQuestions: PropDefinition = {
  name: "",
  optional: false,
  type: {
    kind: "union",
    syntax: "EvaluationQuestion",
    types: [
      {
        kind: "object",
        syntax: "",
        properties: [
          {
            name: "type",
            optional: false,
            type: { kind: "constant", syntax: '"choice"', value: "choice" },
          },
          { name: "instructions", optional: false, type: TEXT },
          {
            name: "criteria",
            optional: false,
            type: {
              kind: "record",
              syntax: "",
              value: { name: "", optional: false, type: TEXT },
            },
          },
        ],
      },
      {
        kind: "object",
        syntax: "",
        properties: [
          {
            name: "type",
            optional: false,
            type: { kind: "constant", syntax: '"boolean"', value: "boolean" },
          },
          { name: "instructions", optional: false, type: TEXT },
          {
            name: "criteria",
            optional: true,
            type: { kind: "object", syntax: "", properties: [] },
          },
        ],
      },
    ],
  },
};

describe("questionKinds", () => {
  it("offers a catalog's factories, by their labels", () => {
    const kinds = questionKinds(factoryQuestions);
    expect(kinds.map(k => [k.key, k.label])).toEqual([["noul", "Yes / no"]]);
    expect(kinds[0].create()).toMatchObject({
      kind: "functionCall",
      callee: "noul",
    });
  });

  it("offers a union's cases when questions are object literals", () => {
    const kinds = questionKinds(unionQuestions);
    expect(kinds.map(k => [k.key, k.label])).toEqual([
      ["choice", "Choice"],
      ["boolean", "Boolean"],
    ]);
  });

  it("creates a case with its discriminator set and required fields defaulted", () => {
    const [choice, boolean] = questionKinds(unionQuestions);
    expect(choice.create()).toEqual({
      kind: "object",
      properties: {
        type: { kind: "primitive", value: "choice" },
        instructions: { kind: "primitive", value: "" },
        criteria: { kind: "object", properties: {} },
      },
    });
    // Optional criteria are left out, as a hand-written question would.
    expect(boolean.create()).toEqual({
      kind: "object",
      properties: {
        type: { kind: "primitive", value: "boolean" },
        instructions: { kind: "primitive", value: "" },
      },
    });
  });

  it("offers nothing for a definition that is neither", () => {
    expect(questionKinds({ name: "", optional: false, type: TEXT })).toEqual(
      [],
    );
  });
});

describe("addQuestion", () => {
  it("appends a default call to the factory under a fresh id", () => {
    const [kind] = questionKinds(factoryQuestions);
    const { id, questions } = addQuestion({ refund: q("Refund?") }, kind);
    expect(id).toBe("question_2");
    expect(Object.keys(questions)).toEqual(["refund", "question_2"]);
    expect(questions.question_2).toEqual({
      kind: "functionCall",
      callee: "noul",
      args: [{ kind: "primitive", value: "" }],
      binding: noul.binding,
    });
  });
});

describe("renameQuestion", () => {
  it("keeps the question where it was", () => {
    const renamed = renameQuestion(
      { a: q("1"), b: q("2"), c: q("3") },
      "b",
      "team",
    );
    expect(Object.keys(renamed)).toEqual(["a", "team", "c"]);
  });
});

describe("questionEntries", () => {
  it("reads an object's questions, and nothing from anything else", () => {
    expect(questionEntries(undefined)).toEqual({});
    expect(
      questionEntries({ kind: "object", properties: { a: q("x") } }),
    ).toEqual({ a: q("x") });
    expect(
      questionEntries({ kind: "raw", sourceText: "buildQuestions()" }),
    ).toBeUndefined();
  });
});
