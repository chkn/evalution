// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type {
  DatasetField,
  ExecutionInput,
  NormalizedPrompt,
  PropDefinition,
  ResourceInfo,
} from "../../shared/types";
import {
  changesAnything,
  chosenResources,
  datasetInputSources,
  rowChanges,
  rowEditorState,
} from "./dataset-row-editing";
import { instanceUri } from "./pseudo-sources";

const def = (name: string, syntax: string): PropDefinition => ({
  name,
  optional: false,
  type: { kind: "primitive", syntax, base: "string" },
});

const TASK = def("taskId", "TaskId");
const TITLE = def("title", "string");
const SEEDED: ResourceInfo = {
  uri: "a.playground.ts#seeded",
  label: "Seeded",
  scope: "run",
  parameters: [def("title", "string")],
};
const SEEDED_ID: ResourceInfo = {
  uri: "a.playground.ts#seeded.id",
  label: "id",
  scope: "run",
  parent: SEEDED.uri,
};

const prompt = (overrides: Partial<NormalizedPrompt> = {}): NormalizedPrompt =>
  ({
    id: "p",
    name: "p",
    functionParameters: [TASK],
    executeParameters: [def("ctx", "Ctx")],
    inputSources: {
      resources: [SEEDED, SEEDED_ID],
      functionSlots: { taskId: [SEEDED_ID.uri] },
      executeSlots: { "ctx.db": [SEEDED.uri], ctxOther: ["x"] },
      resourceSlots: { [SEEDED.uri]: { title: [] } },
    },
    ...overrides,
  }) as unknown as NormalizedPrompt;

const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

describe("datasetInputSources", () => {
  it("gives each field the slots of the parameter it matches", () => {
    const fields: DatasetField[] = [
      { id: "0", def: TASK },
      { id: "1", def: def("ctx", "Ctx") },
      { id: "2", def: TITLE },
      // Same name, other type: not a match.
      { id: "3", def: def("taskId", "string") },
    ];
    expect(datasetInputSources(fields, prompt())).toEqual({
      resources: [SEEDED, SEEDED_ID],
      fieldSlots: {
        "0": { taskId: [SEEDED_ID.uri] },
        "1": { "ctx.db": [SEEDED.uri] },
      },
      resourceSlots: { [SEEDED.uri]: { title: [] } },
    });
  });

  it("is undefined without a prompt or its sources", () => {
    expect(datasetInputSources([], undefined)).toBeUndefined();
    expect(
      datasetInputSources([], prompt({ inputSources: undefined })),
    ).toBeUndefined();
  });
});

describe("rowChanges", () => {
  const taskCell: ExecutionInput = {
    kind: "instance",
    name: "task",
    output: "id",
  };
  const task = { uri: SEEDED.uri, args: { title: text("Buy milk") } };

  it("commits nothing for an untouched row, however it was built", () => {
    // Keys in another order than the editor would write them.
    const row = {
      cells: {
        "0": { output: "id", name: "task", kind: "instance" } as ExecutionInput,
        "1": text("hello"),
      },
      resources: { task: { args: task.args, uri: task.uri, receipt: "r" } },
    };
    const changes = rowChanges(["0", "1", "2"], rowEditorState(row), row);
    expect(changes).toEqual({ cells: {} });
    expect(changesAnything(changes)).toBe(false);
  });

  it("folds a chosen instance into a cell, and a new instance into resources", () => {
    const row = { cells: { "1": text("hello") } };
    const state = rowEditorState(row);
    state.selections["0"] = { resources: { "": instanceUri("task", "id") } };
    state.instances.task = {
      uri: SEEDED.uri,
      args: { title: { value: { kind: "primitive", value: "Buy milk" } } },
    };
    expect(rowChanges(["0", "1"], state, row)).toEqual({
      cells: { "0": taskCell },
      resources: { task },
    });
  });

  it("clears a field emptied in its editor and removes a dropped instance, leaving the rest", () => {
    const row = {
      cells: { "0": taskCell, "1": text("hello") },
      resources: { task, other: { uri: SEEDED.uri } },
    };
    const state = rowEditorState(row);
    state.selections["1"] = { value: { kind: "primitive", value: "" } };
    state.selections["0"] = {};
    delete state.instances.other;
    expect(rowChanges(["1"], state, row)).toEqual({
      cells: { "1": null },
      resources: { other: null },
    });
  });
});

describe("chosenResources", () => {
  it("changes when a source is chosen or an instance renamed, not when a value is typed", () => {
    const state = rowEditorState({
      cells: { "0": text("a") },
      resources: { task: { uri: SEEDED.uri } },
    });
    const before = chosenResources(state);
    const typed = {
      ...state,
      selections: { "0": { value: { kind: "primitive", value: "ab" } } },
      instances: {
        task: {
          uri: SEEDED.uri,
          args: { title: { value: { kind: "primitive", value: "x" } } },
        },
      },
    } as typeof state;
    expect(chosenResources(typed)).toBe(before);
    const chosen = {
      ...state,
      selections: { "0": { resources: { "": instanceUri("task") } } },
    };
    expect(chosenResources(chosen)).not.toBe(before);
    const renamed = {
      ...state,
      instances: { renamed: { uri: SEEDED.uri, args: {} } },
    };
    expect(chosenResources(renamed)).not.toBe(before);
  });
});
