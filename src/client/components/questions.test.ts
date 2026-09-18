// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropValue, ValueFactory } from "ts-proppy";
import { describe, expect, it } from "vitest";
import {
  addQuestion,
  mintQuestionId,
  questionEntries,
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

describe("addQuestion", () => {
  it("appends a default call to the factory under a fresh id", () => {
    const { id, questions } = addQuestion({ refund: q("Refund?") }, noul);
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
