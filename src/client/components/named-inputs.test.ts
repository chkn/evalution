// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { fieldsForPrompt } from "../../shared/dataset-fields";
import type {
  Dataset,
  DatasetField,
  ExecutionInput,
  NormalizedPrompt,
  PropDefinition,
} from "../../shared/types";
import {
  fieldsForTrace,
  fromPanel,
  fromRow,
  fromTrace,
  staleFields,
  toCells,
  toPanel,
} from "./named-inputs";

function def(
  name: string,
  syntax = "string",
  kind: PropDefinition["type"]["kind"] = "primitive",
): PropDefinition {
  return {
    name,
    optional: false,
    type: { kind, syntax } as PropDefinition["type"],
  };
}

const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

const DB_URI = ".evalution/playground/db.ts#db";
const TASK_URI = ".evalution/playground/tasks.ts#seededTask";

function prompt(overrides: Partial<NormalizedPrompt> = {}): NormalizedPrompt {
  return {
    id: "tasks.prompt.ts#classify",
    providerId: "files",
    name: "classify",
    style: "chat",
    functionParameters: [def("ticket"), def("db", "Db", "opaque")],
    executeParameters: [def("toolsContext", "{ db: Db; userId: string }")],
    inputSources: {
      resources: [
        { uri: DB_URI, label: "db", scope: "server" },
        { uri: TASK_URI, label: "seededTask", scope: "run" },
      ],
      functionSlots: {},
      executeSlots: {},
    },
    modelEditable: true,
    modelParameters: [],
    systemEditable: true,
    messages: [],
    messagesEditable: true,
    ...overrides,
  } as NormalizedPrompt;
}

function fields(...defs: PropDefinition[]): DatasetField[] {
  return defs.map((d, i) => ({ id: i.toString(36), def: d }));
}

function dataset(fs: DatasetField[]): Dataset {
  return { id: "d", name: "D", fields: fs, createdAt: 0, updatedAt: 0 };
}

describe("toCells", () => {
  it("matches on name *and* type.syntax", () => {
    const { cells, matched, skipped } = toCells(
      [
        { def: def("ticket"), input: text("hi") },
        { def: def("verbose", "boolean"), input: text("true") },
      ],
      fields(def("ticket"), def("verbose", "string")),
    );
    expect(cells).toEqual({ "0": text("hi") });
    expect(matched).toBe(1);
    // Same name, different type: skipped rather than coerced.
    expect(skipped).toEqual([{ name: "verbose", reason: "no-match" }]);
  });

  it("treats a second input for an already-filled field as the same value", () => {
    const { cells, matched, skipped } = toCells(
      [
        { def: def("userId"), input: text("u1") },
        { def: def("userId"), input: text("u1") },
      ],
      fields(def("userId")),
    );
    expect(cells).toEqual({ "0": text("u1") });
    expect(matched).toBe(1);
    expect(skipped).toEqual([]);
  });
});

describe("fromTrace", () => {
  it("prefers the recorded definitions over the current prompt's", () => {
    const current = prompt({ functionParameters: [def("ticket", "number")] });
    const inputs = fromTrace(
      {
        id: current.id,
        functionInputs: [text("old")],
        parameterDefinitions: [def("ticket", "string")],
      },
      current,
    );
    expect(inputs).toEqual([
      { def: def("ticket", "string"), input: text("old") },
    ]);
    // …and so honestly no longer fits today's signature.
    expect(toPanel(inputs, current).skipped).toEqual([
      { name: "ticket", reason: "no-match" },
    ]);
  });

  it("types execute inputs from the recorded execute definitions", () => {
    const ctx: ExecutionInput = {
      kind: "object",
      properties: { db: { kind: "instance", name: "db" }, userId: text("u") },
    };
    const inputs = fromTrace({
      id: "x",
      functionInputs: [],
      executeInputs: { toolsContext: ctx },
      executeParameterDefinitions: [def("toolsContext", "Ctx")],
    });
    expect(inputs).toEqual([{ def: def("toolsContext", "Ctx"), input: ctx }]);
  });

  it("drops the empty placeholder a run records for an unfilled optional parameter", () => {
    const inputs = fromTrace({
      id: "x",
      // `{ value: undefined }` after a JSON round trip.
      functionInputs: [
        text("a"),
        { kind: "value", value: { kind: "primitive" } },
      ],
      parameterDefinitions: [def("a"), def("b")],
    });
    expect(inputs.map(i => i.def.name)).toEqual(["a"]);
  });

  it("maps a production trace's raw arguments by position, leaving opaque slots empty", () => {
    const current = prompt({
      functionParameters: [
        def("taskInfo", "{ title: string }", "object"),
        def("db", "Db", "opaque"),
        def("roster", "string[]", "array"),
      ],
    });
    const inputs = fromTrace(
      {
        id: current.id,
        functionParameters: [{ title: "Milk" }, { live: "handle" }, ["ada"]],
      },
      current,
    );
    expect(inputs).toEqual([
      {
        def: current.functionParameters[0],
        input: {
          kind: "value",
          value: {
            kind: "object",
            properties: { title: { kind: "primitive", value: "Milk" } },
          },
        },
      },
      {
        def: current.functionParameters[2],
        input: {
          kind: "value",
          value: {
            kind: "array",
            elements: [{ kind: "primitive", value: "ada" }],
          },
        },
      },
    ]);
  });

  it("yields nothing for a production trace whose prompt no longer resolves", () => {
    expect(fromTrace({ id: "x", functionParameters: ["a"] })).toEqual([]);
  });
});

describe("toPanel", () => {
  it("drops an instance whose resource isn't in the prompt's scope, and skips what references it", () => {
    const p = prompt();
    const { functionInputs, resources, skipped } = toPanel(
      [
        { def: def("ticket"), input: text("hi") },
        {
          def: def("db", "Db", "opaque"),
          input: { kind: "instance", name: "far" },
        },
      ],
      p,
      {
        far: { uri: "elsewhere.playground.ts#db" },
        near: { uri: DB_URI, receipt: "stripped" },
      },
    );
    expect(functionInputs).toEqual({ ticket: text("hi") });
    expect(resources).toEqual({ near: { uri: DB_URI } });
    expect(skipped).toEqual([{ name: "db", reason: "resource-out-of-scope" }]);
  });

  it("also drops an in-scope instance whose arguments name a dropped one, and what names it", () => {
    const { resources, skipped } = toPanel(
      [
        {
          def: def("db", "Db", "opaque"),
          input: { kind: "instance", name: "grandchild" },
        },
      ],
      prompt(),
      {
        root: { uri: "elsewhere.playground.ts#db" },
        child: {
          uri: DB_URI,
          args: { parent: { kind: "instance", name: "root", output: "id" } },
        },
        grandchild: {
          uri: DB_URI,
          args: { parent: { kind: "instance", name: "child" } },
        },
        near: { uri: DB_URI },
      },
    );
    expect(resources).toEqual({ near: { uri: DB_URI } });
    expect(skipped).toEqual([{ name: "db", reason: "resource-out-of-scope" }]);
  });

  it("fills both a function and an execute parameter of one name and type", () => {
    const p = prompt({
      functionParameters: [def("userId")],
      executeParameters: [def("userId")],
    });
    const { functionInputs, executeInputs } = toPanel(
      [{ def: def("userId"), input: text("u1") }],
      p,
    );
    expect(functionInputs).toEqual({ userId: text("u1") });
    expect(executeInputs).toEqual({ userId: text("u1") });
  });
});

describe("round trip", () => {
  it("panel → row → panel restores the same request", () => {
    const p = prompt();
    const request = {
      functionInputs: {
        ticket: {
          kind: "value",
          value: { kind: "template", value: ["Order ", { expr: "id" }] },
        } as ExecutionInput,
        db: { kind: "instance", name: "task" } as ExecutionInput,
      },
      executeInputs: {
        toolsContext: {
          kind: "object",
          properties: {
            db: { kind: "instance", name: "db" },
            userId: text("u1"),
          },
        } as ExecutionInput,
      },
    };

    const schema = fieldsForPrompt(p).map((f, i) => ({
      id: i.toString(36),
      ...f,
    }));
    const resources = {
      task: { uri: TASK_URI, args: { title: text("Buy milk") } },
      db: { uri: DB_URI },
    };
    const { cells, skipped } = toCells(fromPanel(p, request), schema);
    expect(skipped).toEqual([]);

    const row = { id: "r", cells, resources, createdAt: 0 };
    const back = toPanel(fromRow(dataset(schema), row), p, row.resources);
    expect(back).toEqual({ ...request, resources, skipped: [] });
  });
});

describe("schemas", () => {
  it("builds a new dataset's schema from the whole signature, minus source spans", () => {
    const p = prompt({
      functionParameters: [
        { ...def("ticket"), valueSpan: { start: 1, end: 2 } as any },
        def("userId"),
      ],
      executeParameters: [def("userId")],
    });
    expect(fieldsForPrompt(p)).toEqual([
      { def: def("ticket") },
      { def: def("userId") },
    ]);
  });

  it("builds a trace's schema from its recorded definitions when it has them", () => {
    expect(
      fieldsForTrace(
        {
          id: "x",
          parameterDefinitions: [def("a")],
          executeParameterDefinitions: [def("ctx", "Ctx")],
        },
        prompt(),
        [],
      ),
    ).toEqual([{ def: def("a") }, { def: def("ctx", "Ctx") }]);
  });

  it("reports fields that no longer match the linked prompt", () => {
    const fs = fields(def("ticket"), def("legacyFlag", "boolean"));
    expect(staleFields(fs, prompt()).map(f => f.def.name)).toEqual([
      "legacyFlag",
    ]);
  });

  it("never reports a field added by hand as stale", () => {
    const [ticket, expected] = fields(def("ticket"), def("expectedTitle"));
    expect(
      staleFields([ticket, { ...expected, added: true }], prompt()),
    ).toEqual([]);
  });
});
