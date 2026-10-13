// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  childInputs,
  columnPathId,
  fieldPath,
  InvalidColumnPathError,
  instancePath,
  MAX_REFERENCE_HOPS,
  type PathRow,
  parseColumnPath,
  readColumnPath,
  resolveColumnPath,
} from "./column-paths.ts";
import type { ExecutionInput, PropValue } from "./types.ts";

const prim = (value: string | number | boolean): PropValue => ({
  kind: "primitive",
  value,
});
const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: prim(value),
});

/** A typed-in object value, as a trace's recorded inputs store one. */
const info: ExecutionInput = {
  kind: "value",
  value: { kind: "object", properties: { title: prim("Say hi") } },
};
/** An object grafting a resource instance in beside a typed-in value. */
const seeded: ExecutionInput = {
  kind: "object",
  properties: { title: text("Milk"), owner: { kind: "instance", name: "db" } },
};

/**
 * asgard's planTask row: the prompt's `toolsContext` points at
 * `seededTask.taskId`, and `seededTask`'s arguments hold the title.
 */
const planTask: PathRow = {
  cells: {
    "0": {
      kind: "object",
      properties: {
        create_task: {
          kind: "object",
          properties: {
            db: { kind: "instance", name: "db" },
            rootTaskId: {
              kind: "instance",
              name: "seededTask",
              output: "taskId",
            },
          },
        },
      },
    },
  },
  resources: {
    db: { uri: "file:///db.ts#db" },
    seededTask: {
      uri: "file:///tasks.ts#seededTask",
      args: {
        title: text("Web site for Evalution"),
        parentId: { kind: "instance", name: "root", output: "taskId" },
      },
    },
    root: { uri: "file:///tasks.ts#seededTask", args: { title: text("Root") } },
  },
};

describe("readColumnPath", () => {
  it("reads a whole cell, or absent for a sparse row", () => {
    expect(readColumnPath({ cells: { "1": seeded } }, fieldPath("1"))).toBe(
      seeded,
    );
    expect(readColumnPath({ cells: {} }, fieldPath("1"))).toBe("absent");
    expect(readColumnPath({ cells: {} }, fieldPath("1", ["title"]))).toBe(
      "absent",
    );
  });

  it("steps into an object cell's property", () => {
    expect(
      readColumnPath({ cells: { "1": seeded } }, fieldPath("1", ["title"])),
    ).toEqual(text("Milk"));
  });

  it("steps into a typed-in object's property, wrapped as a value cell", () => {
    expect(
      readColumnPath({ cells: { "2": info } }, fieldPath("2", ["title"])),
    ).toEqual(text("Say hi"));
    expect(
      readColumnPath({ cells: { "2": info } }, fieldPath("2", ["nope"])),
    ).toBe("n/a");
  });

  it("steps through an instance reference into its arguments, ignoring its output", () => {
    expect(
      readColumnPath(
        planTask,
        fieldPath("0", ["create_task", "rootTaskId", "title"]),
      ),
    ).toEqual(text("Web site for Evalution"));
  });

  it("follows a path through two references", () => {
    expect(
      readColumnPath(
        planTask,
        fieldPath("0", ["create_task", "rootTaskId", "parentId", "title"]),
      ),
    ).toEqual(text("Root"));
  });

  it("reads an instance root, and its arguments", () => {
    expect(readColumnPath(planTask, instancePath("seededTask"))).toEqual({
      kind: "instance",
      name: "seededTask",
    });
    expect(
      readColumnPath(planTask, instancePath("seededTask", ["title"])),
    ).toEqual(text("Web site for Evalution"));
    expect(readColumnPath(planTask, instancePath("nope"))).toBe("absent");
  });

  it("ends at anything else, so a further step is n/a", () => {
    const row: PathRow = {
      cells: {
        str: text("plain"),
        arr: {
          kind: "value",
          value: { kind: "array", elements: [prim(1)] } as PropValue,
        },
        col: { kind: "dataset", field: "x" },
        slot: { kind: "input", half: "function", path: "taskId" },
        dangling: { kind: "instance", name: "missing" },
      },
    };
    for (const field of ["str", "arr", "col", "slot", "dangling"]) {
      expect(readColumnPath(row, fieldPath(field, ["any"]))).toBe("n/a");
    }
    expect(
      readColumnPath(
        planTask,
        fieldPath("0", ["create_task", "rootTaskId", "title", "length"]),
      ),
    ).toBe("n/a");
  });

  it("gives up on a reference cycle after the hop limit", () => {
    const row: PathRow = {
      cells: { "0": { kind: "instance", name: "a" } },
      resources: {
        a: { uri: "r", args: { next: { kind: "instance", name: "b" } } },
        b: { uri: "r", args: { next: { kind: "instance", name: "a" } } },
      },
    };
    const within = Array(MAX_REFERENCE_HOPS).fill("next");
    expect(readColumnPath(row, fieldPath("0", within))).toEqual({
      kind: "instance",
      name: "a",
    });
    expect(readColumnPath(row, fieldPath("0", [...within, "next"]))).toBe(
      "n/a",
    );
  });
});

describe("resolveColumnPath", () => {
  it("says which instance argument a path ends at", () => {
    expect(
      resolveColumnPath(
        planTask,
        fieldPath("0", ["create_task", "rootTaskId", "title"]),
      ),
    ).toEqual({
      value: text("Web site for Evalution"),
      argument: { instance: "seededTask", arg: "title" },
    });
    expect(
      resolveColumnPath(planTask, instancePath("seededTask", ["title"]))
        .argument,
    ).toEqual({ instance: "seededTask", arg: "title" });
    // Ending at a property, or a missing argument, names none.
    expect(
      resolveColumnPath({ cells: { "1": seeded } }, fieldPath("1", ["title"]))
        .argument,
    ).toBeUndefined();
    expect(
      resolveColumnPath(planTask, instancePath("seededTask", ["nope"])),
    ).toEqual({ value: "n/a" });
  });
});

describe("childInputs", () => {
  it("lists what a step can reach, in order", () => {
    expect(childInputs(planTask, planTask.cells["0"]).map(([k]) => k)).toEqual([
      "create_task",
    ]);
    expect(
      childInputs(planTask, {
        kind: "instance",
        name: "seededTask",
        output: "taskId",
      }).map(([k]) => k),
    ).toEqual(["title", "parentId"]);
    expect(childInputs(planTask, text("x"))).toEqual([]);
  });
});

describe("columnPathId", () => {
  it("keeps the ids fields and keys had before paths", () => {
    expect(columnPathId(fieldPath("1"))).toBe("1");
    expect(columnPathId(fieldPath("1", ["title"]))).toBe("1/title");
  });

  it("marks an instance root and percent-encodes / and % in keys", () => {
    expect(columnPathId(instancePath("seededTask", ["title"]))).toBe(
      "@seededTask/title",
    );
    expect(columnPathId(fieldPath("1", ["a/b", "50%"]))).toBe("1/a%2Fb/50%25");
  });
});

describe("parseColumnPath", () => {
  it("accepts a field or instance root with string keys", () => {
    expect(parseColumnPath({ root: { field: "1" }, keys: ["a"] })).toEqual(
      fieldPath("1", ["a"]),
    );
    expect(parseColumnPath({ root: { instance: "t" }, keys: [] })).toEqual(
      instancePath("t"),
    );
  });

  it("rejects a malformed root or keys", () => {
    for (const bad of [
      null,
      { root: {}, keys: [] },
      { root: { field: "" }, keys: [] },
      { root: { field: "1" } },
      { root: { field: "1" }, keys: [""] },
      { root: { field: "1" }, keys: [3] },
      { root: { instance: 'a"b' }, keys: [] },
      { root: { instance: "9lives" }, keys: [] },
    ]) {
      expect(() => parseColumnPath(bad)).toThrow(InvalidColumnPathError);
    }
  });
});
