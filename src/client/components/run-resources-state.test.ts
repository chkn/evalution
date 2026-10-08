// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { ResourceInfo } from "../../shared/types";
import { SELF, type Selections } from "./execution-input-state";
import { instanceUri } from "./pseudo-sources";
import {
  adoptCatalogPick,
  defaultInstanceName,
  derivedDependencies,
  duplicateInstance,
  excludedFromArgs,
  fromWireResources,
  type InstanceSelections,
  instanceNameProblem,
  referencesTo,
  removeInstance,
  renameInstance,
  retargetSelections,
  toWireResources,
} from "./run-resources-state";

const catalog: ResourceInfo[] = [
  { uri: "pg.ts#db", label: "DB", scope: "server" },
  {
    uri: "pg.ts#task",
    label: "Task",
    scope: "run",
    dependencies: { db: "pg.ts#db" },
  },
  {
    uri: "pg.ts#task.id",
    label: "Task ID",
    scope: "run",
    parent: "pg.ts#task",
  },
];
const byUri = new Map(catalog.map(r => [r.uri, r]));

const ref = (name: string, output?: string) => ({
  resources: { [SELF]: instanceUri(name, output) },
});

/** A root task, a child taking its id, and a slot bound to the child. */
function hierarchy(): InstanceSelections {
  return {
    root: {
      uri: "pg.ts#task",
      args: { title: { value: { kind: "primitive", value: "Root" } } },
    },
    child: { uri: "pg.ts#task", args: { parentId: ref("root", "id") } },
  };
}

describe("wire round trip", () => {
  it("folds arguments into inputs and back, dropping receipts and empty arguments", () => {
    const instances: InstanceSelections = {
      ...hierarchy(),
      bare: { uri: "pg.ts#db", args: { unused: {} } },
    };
    const wire = toWireResources(instances)!;
    expect(wire).toEqual({
      root: {
        uri: "pg.ts#task",
        args: {
          title: { kind: "value", value: { kind: "primitive", value: "Root" } },
        },
      },
      child: {
        uri: "pg.ts#task",
        args: { parentId: { kind: "instance", name: "root", output: "id" } },
      },
      bare: { uri: "pg.ts#db" },
    });
    expect(
      fromWireResources({ ...wire, root: { ...wire.root!, receipt: "r" } }),
    ).toEqual({ ...hierarchy(), bare: { uri: "pg.ts#db", args: {} } });
    expect(toWireResources({})).toBeUndefined();
  });
});

describe("names", () => {
  it("defaults to the export name, numbered when taken", () => {
    expect(defaultInstanceName("pg.ts#task", [])).toBe("task");
    expect(defaultInstanceName("pg.ts#task", ["task", "task2"])).toBe("task3");
    expect(defaultInstanceName("pg.ts#1st", [])).toBe("r_1st");
  });

  it("says why a name can't be used", () => {
    expect(instanceNameProblem("root", hierarchy())).toMatch(/already/);
    expect(instanceNameProblem("root", hierarchy(), "root")).toBeUndefined();
    expect(instanceNameProblem("-x", {})).toMatch(/letters, digits/);
  });
});

describe("adoptCatalogPick", () => {
  it("adds an instance for a pick, and references the output picked", () => {
    const picked = adoptCatalogPick(hierarchy(), "pg.ts#task.id", byUri);
    expect(picked.uri).toBe(instanceUri("task", "id"));
    expect(picked.instances.task).toEqual({ uri: "pg.ts#task", args: {} });
  });

  it("reuses a server-scoped resource's one instance", () => {
    const once = adoptCatalogPick({}, "pg.ts#db", byUri);
    const twice = adoptCatalogPick(once.instances, "pg.ts#db", byUri);
    expect(twice.instances).toBe(once.instances);
    expect(twice.uri).toBe(instanceUri("db"));
  });
});

describe("rename, remove, duplicate", () => {
  it("renames in place, following references in arguments and slots, and nothing else", () => {
    const renamed = renameInstance(hierarchy(), "root", "parent");
    expect(Object.keys(renamed)).toEqual(["parent", "child"]);
    expect(renamed.child.args.parentId).toEqual(ref("parent", "id"));

    const slots: Selections = {
      taskId: ref("root", "id"),
      other: ref("child"),
      typed: { value: { kind: "primitive", value: "x" } },
    };
    const retargeted = retargetSelections(slots, "root", "parent");
    expect(retargeted.taskId).toEqual(ref("parent", "id"));
    expect(retargeted.other).toBe(slots.other);
    expect(retargeted.typed).toBe(slots.typed);
    expect(retargetSelections(slots, "nope", "x")).toBe(slots);
  });

  it("refuses a rename to a taken name", () => {
    expect(() => renameInstance(hierarchy(), "child", "root")).toThrow(
      /already/,
    );
  });

  it("clears every reference to a removed instance", () => {
    const removed = removeInstance(hierarchy(), "root");
    expect(Object.keys(removed)).toEqual(["child"]);
    expect(removed.child.args.parentId).toEqual({});
    expect(
      retargetSelections({ taskId: ref("root", "id") }, "root", null),
    ).toEqual({ taskId: {} });
  });

  it("duplicates next to the original, with its arguments copied", () => {
    const { instances, name } = duplicateInstance(hierarchy(), "child");
    expect(name).toBe("child2");
    expect(Object.keys(instances)).toEqual(["root", "child", "child2"]);
    expect(instances.child2).toEqual(instances.child);
    expect(instances.child2.args).not.toBe(instances.child.args);
  });
});

describe("references and cycles", () => {
  it("lists the slots and arguments that reference an instance", () => {
    expect(
      referencesTo("root", hierarchy(), [
        {
          selections: {
            taskId: ref("root", "id"),
            toolsContext: {
              resources: { "list_tasks.rootTaskId": instanceUri("root", "id") },
            },
          },
        },
      ]),
    ).toEqual([
      "taskId",
      "toolsContext.list_tasks.rootTaskId",
      "child.parentId",
    ]);
    expect(referencesTo("child", hierarchy(), [])).toEqual([]);
  });

  it("excludes the instance itself and everything that reaches it from its arguments", () => {
    const instances: InstanceSelections = {
      ...hierarchy(),
      grandchild: { uri: "pg.ts#task", args: { parentId: ref("child", "id") } },
    };
    expect([...excludedFromArgs(instances, "root")].sort()).toEqual([
      "child",
      "grandchild",
      "root",
    ]);
    expect([...excludedFromArgs(instances, "grandchild")]).toEqual([
      "grandchild",
    ]);
  });
});

describe("derivedDependencies", () => {
  it("lists a dependency the run doesn't declare, with what uses it", () => {
    expect(derivedDependencies(hierarchy(), byUri)).toEqual([
      { uri: "pg.ts#db", usedBy: ["root", "child"] },
    ]);
  });

  it("leaves out a dependency declared once, and flags one declared twice", () => {
    expect(
      derivedDependencies(
        { ...hierarchy(), main: { uri: "pg.ts#db", args: {} } },
        byUri,
      ),
    ).toEqual([]);
    expect(
      derivedDependencies(
        {
          ...hierarchy(),
          a: { uri: "pg.ts#db", args: {} },
          b: { uri: "pg.ts#db", args: {} },
        },
        byUri,
      ),
    ).toEqual([
      { uri: "pg.ts#db", usedBy: ["root", "child"], ambiguous: ["a", "b"] },
    ]);
  });
});
