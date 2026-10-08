// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { ExecutionInput, PropDefinition } from "../../shared/types";
import { prefillBindings } from "./eval-bindings";

const def = (name: string, syntax = "string"): PropDefinition => ({
  name,
  optional: false,
  type: { kind: "primitive", syntax, base: "string" },
});

const obj = (name: string, properties: PropDefinition[]): PropDefinition => ({
  name,
  optional: false,
  type: { kind: "object", syntax: `{…}`, properties },
});

const db: ExecutionInput = { kind: "instance", name: "db" };
const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

const empty = { functionInputs: {}, executeInputs: {} };

describe("prefillBindings", () => {
  it("binds a slot to the column that matches it by name and type", () => {
    const { inputs, matched } = prefillBindings({
      prompt: { functionParameters: [def("title"), def("taskId", "TaskId")] },
      fields: [
        { id: "0", def: def("title") },
        { id: "1", def: def("taskId", "string") },
      ],
      inputs: empty,
      checks: [],
      checkInfos: [],
    });
    expect(inputs.functionInputs).toEqual({
      title: { kind: "dataset", field: "0" },
    });
    expect(matched).toEqual(["fn:title"]);
  });

  it("falls back to what the playground last ran, resources and all", () => {
    const { inputs } = prefillBindings({
      prompt: {
        functionParameters: [def("title")],
        executeParameters: [obj("db", [])],
      },
      fields: [],
      inputs: empty,
      checks: [],
      checkInfos: [],
      stored: {
        functionInputs: { title: text("hi") },
        executeInputs: { db },
        resources: {
          db: { uri: "db.ts#db", receipt: "r" },
          unused: { uri: "db.ts#other" },
        },
      },
    });
    // The instance a taken binding names comes along; the rest don't.
    expect(inputs).toEqual({
      functionInputs: { title: text("hi") },
      executeInputs: { db },
      resources: { db: { uri: "db.ts#db" } },
    });
  });

  it("fills an object slot property by property", () => {
    const { inputs, matched } = prefillBindings({
      prompt: {
        functionParameters: [obj("ctx", [def("user"), def("db", "Db")])],
      },
      fields: [{ id: "0", def: def("user") }],
      inputs: empty,
      checks: [],
      checkInfos: [],
      stored: {
        functionInputs: { ctx: { kind: "object", properties: { db } } },
      },
    });
    expect(inputs.functionInputs.ctx).toEqual({
      kind: "object",
      properties: { user: { kind: "dataset", field: "0" }, db },
    });
    expect(matched).toEqual(["fn:ctx.user", "fn:ctx.db"]);
  });

  it("never overwrites a binding the user set", () => {
    const { inputs, matched } = prefillBindings({
      prompt: { functionParameters: [def("title")] },
      fields: [{ id: "0", def: def("title") }],
      inputs: { functionInputs: { title: text("mine") }, executeInputs: {} },
      checks: [],
      checkInfos: [],
    });
    expect(inputs.functionInputs.title).toEqual(text("mine"));
    expect(matched).toEqual([]);
  });

  it("binds a check parameter to a column, else to the same-named slot", () => {
    const { checks, matched } = prefillBindings({
      prompt: { functionParameters: [def("taskId", "TaskId")] },
      fields: [{ id: "0", def: def("expected") }],
      inputs: empty,
      checks: [
        { id: "c", uri: "checks.ts#creates", args: {} },
        { id: "d", uri: "gone.ts#x", args: {} },
      ],
      checkInfos: [
        {
          uri: "checks.ts#creates",
          label: "Creates",
          parameters: [def("taskId", "TaskId"), def("expected"), def("other")],
        },
      ],
    });
    expect(checks[0]!.args).toEqual({
      taskId: { kind: "input", half: "function", path: "taskId" },
      expected: { kind: "dataset", field: "0" },
    });
    expect(checks[1]!.args).toEqual({});
    expect(matched).toEqual(["check:c:taskId", "check:c:expected"]);
  });
});
