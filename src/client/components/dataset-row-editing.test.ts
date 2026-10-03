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
  chosenResources,
  datasetInputSources,
  rowCellChanges,
  rowEditorState,
} from "./dataset-row-editing";

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
const BY_URI = new Map([SEEDED, SEEDED_ID].map(r => [r.uri, r]));

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

describe("rowCellChanges", () => {
  const seededCell: ExecutionInput = {
    kind: "resource",
    uri: SEEDED_ID.uri,
    args: { title: text("Buy milk") },
  };

  it("commits nothing for an untouched row, however its cells were built", () => {
    // Keys in another order than the editor would write them.
    const cells: Record<string, ExecutionInput> = {
      "0": {
        args: { title: text("Buy milk") },
        uri: SEEDED_ID.uri,
        kind: "resource",
      } as ExecutionInput,
      "1": text("hello"),
    };
    const state = rowEditorState(cells, BY_URI);
    expect(rowCellChanges(["0", "1", "2"], state, cells, BY_URI)).toEqual({});
  });

  it("folds a chosen resource and its arguments back into a cell", () => {
    const cells = { "1": text("hello") };
    const state = rowEditorState(cells, BY_URI);
    state.selections["0"] = { resources: { "": SEEDED_ID.uri } };
    // Arguments live under the root resource, as in the panel.
    state.resourceArgs[SEEDED.uri] = {
      title: { value: { kind: "primitive", value: "Buy milk" } },
    };
    expect(rowCellChanges(["0", "1"], state, cells, BY_URI)).toEqual({
      "0": seededCell,
    });
  });

  it("clears a field emptied in its editor, and leaves other fields alone", () => {
    const cells = { "0": seededCell, "1": text("hello") };
    const state = rowEditorState(cells, BY_URI);
    state.selections["1"] = { value: { kind: "primitive", value: "" } };
    state.selections["0"] = {};
    expect(rowCellChanges(["1"], state, cells, BY_URI)).toEqual({ "1": null });
  });
});

describe("chosenResources", () => {
  it("changes when a resource is chosen, not when a value is typed", () => {
    const state = rowEditorState({ "0": text("a") }, BY_URI);
    const before = chosenResources(state);
    const typed = {
      ...state,
      selections: { "0": { value: { kind: "primitive", value: "ab" } } },
    } as typeof state;
    expect(chosenResources(typed)).toBe(before);
    const chosen = {
      ...state,
      selections: { "0": { resources: { "": SEEDED.uri } } },
    };
    expect(chosenResources(chosen)).not.toBe(before);
  });
});
