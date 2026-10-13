// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { DatasetRow } from "../../dataset/dataset-types.ts";
import {
  addInstance,
  danglingReferences,
  describeReference,
  diffRow,
  references,
  removeInstances,
  setArgs,
} from "./index.ts";

const TASK = ".evalution/playground/db.ts#seededTask";
const ref = (name: string, output?: string) =>
  ({ kind: "instance", name, ...(output && { output }) }) as const;
const text = (value: string) =>
  ({ kind: "value", value: { kind: "primitive", value } }) as const;

const row: DatasetRow = {
  id: "r1",
  createdAt: 0,
  cells: {
    "0": ref("focus"),
    "2": {
      kind: "object",
      properties: {
        create_task: {
          kind: "object",
          properties: { rootTaskId: ref("focus", "taskId") },
        },
      },
    },
  },
  resources: {
    project: { uri: TASK, args: { title: text("Evalution") } },
    focus: {
      uri: TASK,
      args: { title: text("Web site"), parentTaskId: ref("project", "taskId") },
    },
    brandKit: {
      uri: TASK,
      args: {
        title: text("Brand kit"),
        parentTaskId: ref("project", "taskId"),
      },
    },
  },
};

describe("references", () => {
  it("finds every instance reference, in cells and arguments, at any depth", () => {
    expect(references(row)).toEqual([
      { from: { cell: "0", path: [] }, to: "focus" },
      {
        from: { cell: "2", path: ["create_task", "rootTaskId"] },
        to: "focus",
        output: "taskId",
      },
      {
        from: { instance: "focus", arg: "parentTaskId", path: [] },
        to: "project",
        output: "taskId",
      },
      {
        from: { instance: "brandKit", arg: "parentTaskId", path: [] },
        to: "project",
        output: "taskId",
      },
    ]);
    expect(describeReference(references(row)[1])).toBe(
      "cell 2 › create_task › rootTaskId → focus.taskId",
    );
  });
});

describe("addInstance", () => {
  it("names the instance from the hint, avoiding names already taken", () => {
    const first = addInstance(row, { uri: TASK }, "Launch screenshots");
    expect(first.name).toBe("launchScreenshots");
    expect(first.update).toEqual({
      rowId: "r1",
      cells: {},
      resources: { launchScreenshots: { uri: TASK } },
    });
    expect(addInstance(row, { uri: TASK }, "brand kit").name).toBe("brandKit2");
    expect(addInstance(row, { uri: TASK }, "2nd pass!").name).toBe(
      "instance2ndPass",
    );
  });
});

describe("setArgs", () => {
  it("replaces some arguments and removes others", () => {
    expect(
      setArgs(row, "brandKit", {
        title: text("Brand"),
        parentTaskId: null,
      }),
    ).toEqual({
      rowId: "r1",
      cells: {},
      resources: { brandKit: { uri: TASK, args: { title: text("Brand") } } },
    });
    expect(() => setArgs(row, "nope", {})).toThrow("no instance 'nope'");
  });
});

describe("removeInstances", () => {
  it("removes instances nothing else refers to", () => {
    expect(removeInstances(row, ["brandKit"])).toEqual({
      rowId: "r1",
      cells: {},
      resources: { brandKit: null },
    });
  });

  it("removes a subtree whose references are all inside it", () => {
    const subtree = { ...row, cells: {} };
    expect(removeInstances(subtree, ["project", "focus", "brandKit"])).toEqual({
      rowId: "r1",
      cells: {},
      resources: { project: null, focus: null, brandKit: null },
    });
  });

  it("refuses, listing them, when something left would still refer to one", () => {
    const result = removeInstances(row, ["project", "brandKit"]);
    expect(result).toEqual({
      dangling: [
        {
          from: { instance: "focus", arg: "parentTaskId", path: [] },
          to: "project",
          output: "taskId",
        },
      ],
    });
    expect("dangling" in removeInstances(row, ["focus"])).toBe(true);
  });
});

describe("danglingReferences", () => {
  it("finds references to instances the row doesn't declare", () => {
    expect(danglingReferences(row)).toEqual([]);
    const { project: _, ...rest } = row.resources!;
    expect(
      danglingReferences({ ...row, resources: rest }).map(r => r.to),
    ).toEqual(["project", "project"]);
  });
});

describe("diffRow", () => {
  const stored = {
    cells: { "0": text("a"), "1": text("b"), "2": text("c") },
    resources: {
      keep: { uri: TASK, args: { title: text("same") } },
      edit: { uri: TASK, args: { title: text("old"), status: text("new") } },
      gone: { uri: TASK },
    },
  };

  it("lists what was added, changed and removed, in cells and instances", () => {
    const next = {
      cells: { "0": text("a"), "1": text("B"), "3": text("d") },
      resources: {
        keep: stored.resources.keep,
        edit: { uri: TASK, args: { title: text("new"), status: text("new") } },
        fresh: { uri: TASK },
      },
    };
    expect(diffRow(stored, next)).toEqual({
      cells: { added: ["3"], changed: ["1"], removed: ["2"] },
      resources: { added: ["fresh"], changed: ["edit"], removed: ["gone"] },
    });
  });

  it("finds nothing in rows that say the same, whatever their key order", () => {
    const same = {
      cells: { "2": text("c"), "1": text("b"), "0": text("a") },
      resources: {
        gone: { uri: TASK },
        edit: { args: { status: text("new"), title: text("old") }, uri: TASK },
        keep: { uri: TASK, args: { title: text("same") } },
      },
    };
    const none = { added: [], changed: [], removed: [] };
    expect(diffRow(stored, same)).toEqual({ cells: none, resources: none });
  });

  it("treats a row with no resources as having none", () => {
    expect(
      diffRow({ cells: {} }, { cells: {}, resources: { a: { uri: TASK } } })
        .resources,
    ).toEqual({ added: ["a"], changed: [], removed: [] });
    expect(
      diffRow({ cells: {}, resources: { a: { uri: TASK } } }, { cells: {} })
        .resources,
    ).toEqual({ added: [], changed: [], removed: ["a"] });
  });
});
