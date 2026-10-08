// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { PropDefinition, ResourceInfo } from "../../shared/types";
import { fromExecutionInput, toExecutionInput } from "./execution-input-state";
import {
  checkParameterSources,
  columnUri,
  describeInstanceSource,
  describePseudoSource,
  INSTANCES_GROUP,
  inputUri,
  instanceUri,
  NEW_COLUMN_URI,
  NEW_GROUP,
  parseInstanceUri,
  pseudoInput,
  withInstanceSources,
  withPseudoSources,
} from "./pseudo-sources";
import { buildSourceTree } from "./source-tree";

const def = (name: string, syntax: string, base = syntax): PropDefinition => ({
  name,
  optional: false,
  type: { kind: "primitive", syntax, base: base as "string" },
});

const functionParameters = [
  def("taskId", "TaskId", "string"),
  def("title", "string"),
  def("count", "number"),
];

/** No slot bound at all. */
const NO_BINDINGS = { functionInputs: {}, executeInputs: {} };

describe("pseudo-source URIs", () => {
  it("round-trip through the panel's selection state", () => {
    for (const input of [
      { kind: "dataset", field: "3" },
      { kind: "input", half: "execute", path: "ctx.db" },
      { kind: "instance", name: "root" },
      { kind: "instance", name: "root", output: "taskId" },
    ] as const) {
      const selection = fromExecutionInput(input);
      expect(toExecutionInput(selection)).toEqual(input);
    }
    expect(pseudoInput(columnUri("a"))).toEqual({
      kind: "dataset",
      field: "a",
    });
    expect(pseudoInput(".evalution/playground/db.ts#db")).toBeUndefined();
    expect(pseudoInput(NEW_COLUMN_URI)).toBeUndefined();
  });

  it("name an instance and an output of it", () => {
    expect(parseInstanceUri(instanceUri("root"))).toEqual({ name: "root" });
    expect(parseInstanceUri(instanceUri("root", "taskId"))).toEqual({
      name: "root",
      output: "taskId",
    });
    expect(parseInstanceUri(columnUri("0"))).toBeUndefined();
  });
});

describe("withInstanceSources", () => {
  const catalog: ResourceInfo[] = [
    { uri: "t.ts#task", label: "Seeded task", scope: "run" },
    {
      uri: "t.ts#task.id",
      label: "Task ID",
      scope: "run",
      parent: "t.ts#task",
    },
    { uri: "t.ts#other", label: "Other", scope: "run", group: ["Misc"] },
  ];
  const sources = {
    resources: catalog,
    functionSlots: { taskId: ["t.ts#task.id"], other: ["t.ts#other"] },
    executeSlots: {},
  };
  const instances = { root: { uri: "t.ts#task" }, child: { uri: "t.ts#task" } };

  it("offers each instance first wherever its resource or output fits", () => {
    const withInstances = withInstanceSources(sources, instances);
    expect(withInstances.functionSlots.taskId).toEqual([
      instanceUri("root", "id"),
      instanceUri("child", "id"),
      "t.ts#task.id",
    ]);
    expect(withInstances.functionSlots.other).toEqual(["t.ts#other"]);
    expect(
      withInstances.resources.filter(r => r.group?.[0] === INSTANCES_GROUP),
    ).toHaveLength(4);
  });

  it("lists instances first and the catalog under New, opened in place where no instance fits", () => {
    const { resources, functionSlots } = withInstanceSources(
      sources,
      instances,
    );
    const pick = (uris: string[]) =>
      buildSourceTree(resources, uris).map(n => n.label);
    expect(pick(functionSlots.taskId!)).toEqual([INSTANCES_GROUP, NEW_GROUP]);
    expect(pick(functionSlots.other!)).toEqual(["Other"]);
  });

  it("leaves sources alone for a run with no instances", () => {
    expect(withInstanceSources(sources, {}).resources).toEqual(catalog);
  });

  it("describes a chip by the instance's resource, or says it's gone", () => {
    const byUri = new Map(catalog.map(r => [r.uri, r]));
    expect(
      describeInstanceSource(instanceUri("root", "id"), instances, byUri),
    ).toEqual({ label: "root.id", note: "Seeded task" });
    expect(
      describeInstanceSource(instanceUri("gone"), instances, byUri),
    ).toEqual({
      label: "gone",
      note: "resource no longer in this run",
      missing: true,
    });
  });
});

describe("withPseudoSources", () => {
  it("offers the panel only other slots whose type fits", () => {
    const sources = withPseudoSources(undefined, {
      functionParameters,
      bindings: NO_BINDINGS,
    });
    expect(sources.functionSlots).toEqual({
      taskId: [inputUri("function", "title")],
      title: [inputUri("function", "taskId")],
    });
    expect(sources.resources.map(r => [r.label, r.group])).toContainEqual([
      "= title",
      ["Prompt inputs"],
    ]);
  });

  it("never offers a slot that would close a cycle", () => {
    const sources = withPseudoSources(undefined, {
      functionParameters,
      bindings: {
        functionInputs: {
          title: { kind: "input", half: "function", path: "taskId" },
        },
        executeInputs: {},
      },
    });
    expect(sources.functionSlots.taskId).toBeUndefined();
  });

  it("offers the eval editor every column and slot, and a new column", () => {
    const sources = withPseudoSources(undefined, {
      functionParameters,
      bindings: NO_BINDINGS,
      fields: [{ id: "0", def: def("question", "string") }],
      offerMismatches: true,
      newColumn: true,
    });
    expect(sources.functionSlots.count).toEqual([
      columnUri("0"),
      inputUri("function", "taskId"),
      inputUri("function", "title"),
      NEW_COLUMN_URI,
    ]);
  });

  it("offers columns and slots to a resource's arguments", () => {
    const seeded: ResourceInfo = {
      uri: "db.ts#seeded",
      label: "seeded",
      scope: "run",
      parameters: [def("title", "string")],
    };
    const sources = withPseudoSources(
      { resources: [seeded], functionSlots: {}, executeSlots: {} },
      {
        functionParameters,
        bindings: NO_BINDINGS,
        fields: [{ id: "0", def: def("t", "string") }],
      },
    );
    expect(sources.resourceSlots?.["db.ts#seeded"]?.title).toEqual([
      columnUri("0"),
      inputUri("function", "taskId"),
      inputUri("function", "title"),
    ]);
  });
});

describe("checkParameterSources", () => {
  it("offers every column and slot to each parameter", () => {
    const sources = checkParameterSources([def("expected", "string")], {
      functionParameters,
      fields: [{ id: "0", def: def("question", "string") }],
    });
    expect(sources.functionSlots.expected).toHaveLength(5);
    expect(sources.functionSlots.expected).toContain(NEW_COLUMN_URI);
  });
});

describe("describePseudoSource", () => {
  const options = {
    functionParameters,
    fields: [{ id: "0", def: def("n", "number") }],
  };

  it("warns of a type mismatch", () => {
    expect(
      describePseudoSource(columnUri("0"), def("x", "string").type, options),
    ).toEqual({ note: "column from dataset", warning: "number into string" });
    expect(
      describePseudoSource(
        inputUri("function", "taskId"),
        def("x", "string").type,
        options,
      ),
    ).toEqual({ note: "same value as that input" });
  });

  it("says when the column or slot is gone", () => {
    expect(
      describePseudoSource(columnUri("9"), def("x", "string").type, options),
    ).toEqual({ note: "column no longer exists" });
  });
});
