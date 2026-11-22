// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { ExecutionInput, PropDefinition } from "../../shared/types";
import {
  fromExecutionInput,
  matchingSlotPath,
  missingInputMessage,
  SELF,
  type SlotSelection,
  shiftForRemovedElement,
  toExecutionInput,
} from "./execution-input-state";
import { columnUri, instanceUri } from "./pseudo-sources";

const strVal = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

describe("toExecutionInput", () => {
  it("references an instance, or one of its outputs, chosen for the slot", () => {
    expect(
      toExecutionInput({ resources: { [SELF]: instanceUri("db") } }),
    ).toEqual({ kind: "instance", name: "db" });
    expect(
      toExecutionInput({
        resources: { [SELF]: instanceUri("root", "taskId") },
      }),
    ).toEqual({ kind: "instance", name: "root", output: "taskId" });
  });

  it("grafts an instance into one field of a typed-in object", () => {
    const selection: SlotSelection = {
      value: {
        kind: "object",
        properties: { workspaceId: { kind: "primitive", value: "ws_1" } },
      },
      resources: { db: instanceUri("db") },
    };
    expect(toExecutionInput(selection)).toEqual({
      kind: "object",
      properties: {
        workspaceId: strVal("ws_1"),
        db: { kind: "instance", name: "db" },
      },
    });
  });

  it("grafts an instance into one element of a typed-in array", () => {
    const selection: SlotSelection = {
      value: {
        kind: "array",
        elements: [
          { kind: "primitive", value: "tsk_1" },
          { kind: "primitive", value: "" },
        ],
      },
      resources: { "1": instanceUri("forge", "taskId") },
    };
    expect(toExecutionInput(selection)).toEqual({
      kind: "array",
      elements: [
        strVal("tsk_1"),
        { kind: "instance", name: "forge", output: "taskId" },
      ],
    });
  });

  it("grafts an instance into an array nested in an object", () => {
    const selection: SlotSelection = {
      value: {
        kind: "object",
        properties: {
          label: { kind: "primitive", value: "L" },
          after: {
            kind: "array",
            elements: [{ kind: "primitive", value: "" }],
          },
        },
      },
      resources: { "after.0": instanceUri("forge", "taskId") },
    };
    expect(toExecutionInput(selection)).toEqual({
      kind: "object",
      properties: {
        label: strVal("L"),
        after: {
          kind: "array",
          elements: [{ kind: "instance", name: "forge", output: "taskId" }],
        },
      },
    });
  });

  it("leaves out a catalog URI, which only stands for something once adopted", () => {
    expect(
      toExecutionInput({ resources: { [SELF]: "pg.ts#db" } }),
    ).toBeUndefined();
    expect(
      toExecutionInput({
        value: { kind: "primitive", value: "x" },
        resources: { db: "pg.ts#db" },
      }),
    ).toEqual(strVal("x"));
  });
});

describe("fromExecutionInput", () => {
  it("restores instance, column and value inputs as the panel chose them", () => {
    const input: ExecutionInput = {
      kind: "object",
      properties: {
        db: { kind: "instance", name: "db" },
        title: { kind: "dataset", field: "0" },
        workspaceId: strVal("ws_1"),
      },
    };
    const selection = fromExecutionInput(input);
    expect(selection).toEqual({
      value: {
        kind: "object",
        properties: { workspaceId: { kind: "primitive", value: "ws_1" } },
      },
      resources: { db: instanceUri("db"), title: columnUri("0") },
    });
    expect(toExecutionInput(selection)).toEqual({
      kind: "object",
      properties: {
        workspaceId: strVal("ws_1"),
        db: { kind: "instance", name: "db" },
        title: { kind: "dataset", field: "0" },
      },
    });
  });

  it("restores an array with bound elements, keeping every element's place", () => {
    const input: ExecutionInput = {
      kind: "array",
      elements: [
        { kind: "instance", name: "root", output: "taskId" },
        strVal("tsk_1"),
        { kind: "instance", name: "forge", output: "taskId" },
      ],
    };
    const selection = fromExecutionInput(input);
    expect(selection.resources).toEqual({
      "0": instanceUri("root", "taskId"),
      "2": instanceUri("forge", "taskId"),
    });
    expect(
      selection.value?.kind === "array" && selection.value.elements.length,
    ).toBe(3);
    expect(toExecutionInput(selection)).toEqual(input);
  });

  it("restores an inline resource stored before instances existed as an empty slot", () => {
    const legacy = {
      kind: "resource",
      uri: "pg.ts#db",
    } as unknown as ExecutionInput;
    expect(fromExecutionInput(legacy)).toEqual({});
  });
});

describe("shiftForRemovedElement", () => {
  const resources = {
    [SELF]: instanceUri("whole"),
    "after.0": instanceUri("a", "taskId"),
    "after.1": instanceUri("b", "taskId"),
    "after.1.inner": instanceUri("b2"),
    "after.2": instanceUri("c", "taskId"),
    "after10.1": instanceUri("other"),
    label: instanceUri("label"),
  };

  it("drops the removed element's sources and moves later ones down", () => {
    expect(shiftForRemovedElement(resources, "after", 1)).toEqual({
      [SELF]: instanceUri("whole"),
      "after.0": instanceUri("a", "taskId"),
      "after.1": instanceUri("c", "taskId"),
      "after10.1": instanceUri("other"),
      label: instanceUri("label"),
    });
  });

  it("shifts the elements of the slot's own array", () => {
    expect(
      shiftForRemovedElement(
        { "0": instanceUri("a"), "1": instanceUri("b") },
        SELF,
        0,
      ),
    ).toEqual({ "0": instanceUri("b") });
  });
});

describe("matchingSlotPath", () => {
  const slots = {
    after: ["pg.ts#seededTaskDependency"],
    "after.[]": ["pg.ts#seededTask.taskId"],
    "ctx.list.[].db": ["pg.ts#db"],
    "ctx.list.[]": [],
  };

  it("finds an element's slot from its index", () => {
    expect(matchingSlotPath(slots, "after.3")).toBe("after.[]");
    expect(matchingSlotPath(slots, "ctx.list.0.db")).toBe("ctx.list.[].db");
  });

  it("prefers a slot named exactly", () => {
    expect(matchingSlotPath(slots, "after")).toBe("after");
  });

  it("is undefined when there's no such slot", () => {
    expect(matchingSlotPath(slots, "label")).toBeUndefined();
    expect(matchingSlotPath(slots, "after.x")).toBeUndefined();
  });
});

describe("missingInputMessage", () => {
  const prop = (
    name: string,
    type: PropDefinition["type"],
    optional = false,
  ): PropDefinition => ({ name, optional, type });
  const str = (name: string, optional = false) =>
    prop(
      name,
      { kind: "primitive", syntax: "string", base: "string" },
      optional,
    );
  const db = prop("db", { kind: "opaque", syntax: "Db" });
  const toolsContext = prop("toolsContext", {
    kind: "object",
    syntax: "ToolsContext",
    properties: [
      prop("update_task", {
        kind: "object",
        syntax: "{ db: Db; runId: string; note?: string }",
        properties: [db, str("runId"), str("note", true)],
      }),
    ],
  });
  const withDb = (
    more: Record<string, ExecutionInput> = {},
  ): ExecutionInput => ({
    kind: "object",
    properties: {
      update_task: {
        kind: "object",
        properties: { db: { kind: "instance", name: "db" }, ...more },
      },
    },
  });

  it("names a required slot left empty", () => {
    expect(missingInputMessage(str("question"), undefined, false)).toBe(
      "Parameter 'question' is required",
    );
  });

  it("names a required property an object input leaves out, by its path", () => {
    expect(missingInputMessage(toolsContext, withDb(), false)).toBe(
      "Parameter 'toolsContext.update_task.runId' is required",
    );
  });

  it("points a missing opaque property at the resources that supply one", () => {
    const input: ExecutionInput = {
      kind: "object",
      properties: {
        update_task: { kind: "object", properties: { runId: strVal("run_1") } },
      },
    };
    expect(missingInputMessage(toolsContext, input, true)).toBe(
      "Parameter 'toolsContext.update_task.db' needs a resource — pick one from its dropdown",
    );
  });

  it("is satisfied once every required property is bound", () => {
    expect(
      missingInputMessage(
        toolsContext,
        withDb({ runId: strVal("run_1") }),
        false,
      ),
    ).toBeUndefined();
  });
});
