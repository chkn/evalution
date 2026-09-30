// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { evalProblems } from "./eval-problems.ts";
import type { CheckInfo, PropDefinition } from "./types.ts";

const string = (name: string, optional = false): PropDefinition => ({
  name,
  optional,
  type: { kind: "primitive", syntax: "string", base: "string" },
});

const prompt = {
  functionParameters: [
    string("question"),
    string("hint", true),
    {
      name: "ctx",
      optional: false,
      type: {
        kind: "object",
        syntax: "{ user: string }",
        properties: [string("user")],
      },
    } as PropDefinition,
  ],
};
const fields = [{ id: "0", def: string("question") }];
const checks: CheckInfo[] = [
  {
    uri: "evalution/checks#outputContains",
    label: "Output contains",
    parameters: [string("text")],
  },
];

describe("evalProblems", () => {
  it("is empty for a fully bound eval", () => {
    expect(
      evalProblems(
        {
          functionInputs: {
            question: { kind: "dataset", field: "0" },
            ctx: {
              kind: "object",
              properties: {
                user: { kind: "input", half: "function", path: "question" },
              },
            },
          },
          executeInputs: {},
        },
        [
          {
            id: "c",
            uri: "evalution/checks#outputContains",
            args: {
              text: { kind: "input", half: "function", path: "question" },
            },
          },
        ],
        { prompt, fields, checks },
      ),
    ).toEqual([]);
  });

  it("lists unbound required slots, following object bindings", () => {
    expect(
      evalProblems(
        {
          functionInputs: { ctx: { kind: "object", properties: {} } },
          executeInputs: {},
        },
        [],
        { prompt, fields, checks },
      ),
    ).toEqual([
      "Input 'question' is required but unbound",
      "Input 'ctx.user' is required but unbound",
    ]);
  });

  it("lists bindings to slots, columns and checks that no longer exist", () => {
    expect(
      evalProblems(
        {
          functionInputs: {
            question: { kind: "dataset", field: "9" },
            gone: { kind: "dataset", field: "0" },
            ctx: { kind: "input", half: "execute", path: "nope" },
          },
          executeInputs: {},
        },
        [
          { id: "a", uri: "x.ts#missing", args: {} },
          {
            id: "b",
            uri: "evalution/checks#outputContains",
            label: "Mine",
            args: { text: { kind: "input", half: "function", path: "nada" } },
          },
        ],
        { prompt, fields, checks },
      ),
    ).toEqual([
      "Input 'question' is bound to a column that no longer exists",
      "Input 'gone' is bound, but the prompt no longer has it",
      "'ctx' names input 'execute:nope', which the prompt doesn't have",
      "Check 'x.ts#missing' no longer exists",
      "Check 'Mine': 'text' names input 'nada', which the prompt doesn't have",
    ]);
  });

  it("lists input cycles and unbound check parameters", () => {
    expect(
      evalProblems(
        {
          functionInputs: {
            question: { kind: "input", half: "function", path: "hint" },
            hint: { kind: "input", half: "function", path: "question" },
            ctx: { kind: "value", value: { kind: "object", properties: {} } },
          },
          executeInputs: {},
        },
        [{ id: "c", uri: "evalution/checks#outputContains", args: {} }],
        { prompt, fields, checks },
      ),
    ).toEqual([
      "Input cycle: question → hint → question",
      "Check 'Output contains': 'text' is required but unbound",
    ]);
  });
});
