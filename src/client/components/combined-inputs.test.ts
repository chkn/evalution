// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { ExecutionInput, PropDefinition } from "../../shared/types";
import {
  collapse,
  collapseLossy,
  expand,
  fanOutGroups,
  fanOutMembers,
  isCombinable,
  resolveLayout,
} from "./combined-inputs";

const str = (name: string, syntax = "string"): PropDefinition => ({
  name,
  optional: false,
  type: { kind: "primitive", syntax, base: "string" },
});

const opaqueDb = (syntax = "Db"): PropDefinition => ({
  name: "db",
  optional: false,
  type: { kind: "opaque", syntax },
});

/** The odin shape from the spec: 4 tools, 11 fields, 4 distinct groups. */
const TOOLS_CONTEXT: PropDefinition = {
  name: "toolsContext",
  optional: false,
  type: {
    kind: "object",
    syntax: "InferToolSetContext<typeof tools>",
    properties: [
      {
        name: "list_tasks",
        optional: false,
        type: {
          kind: "object",
          syntax: "Ctx1",
          properties: [
            opaqueDb(),
            str("workspaceId", "`ws_${string}`"),
            str("rootTaskId", "`tsk_${string}`"),
          ],
        },
      },
      {
        name: "create_task",
        optional: false,
        type: {
          kind: "object",
          syntax: "Ctx1",
          properties: [
            opaqueDb(),
            str("workspaceId", "`ws_${string}`"),
            str("rootTaskId", "`tsk_${string}`"),
          ],
        },
      },
      {
        name: "update_task",
        optional: false,
        type: {
          kind: "object",
          syntax: "Ctx2",
          properties: [opaqueDb(), str("workspaceId", "`ws_${string}`")],
        },
      },
      {
        name: "post_message",
        optional: false,
        type: {
          kind: "object",
          syntax: "Ctx3",
          properties: [
            opaqueDb(),
            str("workspaceId", "`ws_${string}`"),
            str("runId", "`run_${string}`"),
          ],
        },
      },
    ],
  },
};

describe("fanOutMembers", () => {
  it("requires at least two object-typed properties", () => {
    expect(
      fanOutMembers({
        name: "x",
        optional: false,
        type: { kind: "object", syntax: "X", properties: [str("a")] },
      }),
    ).toBeUndefined();
  });

  it("leaves a non-object member out of the count and out of the fields", () => {
    const propDef: PropDefinition = {
      name: "x",
      optional: false,
      type: {
        kind: "object",
        syntax: "X",
        properties: [
          str("sibling"), // not object-typed: not a member
          {
            name: "a",
            optional: false,
            type: { kind: "object", syntax: "A", properties: [str("id")] },
          },
          {
            name: "b",
            optional: false,
            type: { kind: "object", syntax: "B", properties: [str("id")] },
          },
        ],
      },
    };
    const members = fanOutMembers(propDef);
    expect(members?.map(m => m.name)).toEqual(["a", "b"]);

    const groups = fanOutGroups(propDef);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("id");
  });
});

describe("fanOutGroups", () => {
  it("groups the odin shape into db(4), workspaceId(4), rootTaskId(2), runId(1)", () => {
    const groups = fanOutGroups(TOOLS_CONTEXT);
    const byName = Object.fromEntries(groups.map(g => [g.name, g]));

    expect(Object.keys(byName)).toEqual([
      "db",
      "workspaceId",
      "rootTaskId",
      "runId",
    ]);
    expect(byName.db.members).toEqual([
      "list_tasks",
      "create_task",
      "update_task",
      "post_message",
    ]);
    expect(byName.workspaceId.members).toHaveLength(4);
    expect(byName.rootTaskId.members).toEqual(["list_tasks", "create_task"]);
    expect(byName.runId.members).toEqual(["post_message"]);
  });

  it("does not merge a field whose type.syntax differs between two members", () => {
    const propDef: PropDefinition = {
      name: "x",
      optional: false,
      type: {
        kind: "object",
        syntax: "X",
        properties: [
          {
            name: "a",
            optional: false,
            type: {
              kind: "object",
              syntax: "A",
              properties: [str("id", "`a_${string}`")],
            },
          },
          {
            name: "b",
            optional: false,
            type: {
              kind: "object",
              syntax: "B",
              properties: [str("id", "`b_${string}`")],
            },
          },
        ],
      },
    };
    const groups = fanOutGroups(propDef);
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.members)).toEqual([["a"], ["b"]]);
  });

  it("is required if any member requires it, optional only when every member does", () => {
    const propDef: PropDefinition = {
      name: "x",
      optional: false,
      type: {
        kind: "object",
        syntax: "X",
        properties: [
          {
            name: "a",
            optional: false,
            type: {
              kind: "object",
              syntax: "A",
              properties: [{ ...str("id"), optional: true }],
            },
          },
          {
            name: "b",
            optional: false,
            type: {
              kind: "object",
              syntax: "B",
              properties: [{ ...str("id"), optional: false }],
            },
          },
        ],
      },
    };
    expect(fanOutGroups(propDef)[0].optional).toBe(false);
  });
});

describe("isCombinable", () => {
  it("is true once some group has 2+ members", () => {
    expect(isCombinable(fanOutGroups(TOOLS_CONTEXT))).toBe(true);
  });

  it("is false when every group is a singleton", () => {
    const propDef: PropDefinition = {
      name: "x",
      optional: false,
      type: {
        kind: "object",
        syntax: "X",
        properties: [
          {
            name: "a",
            optional: false,
            type: { kind: "object", syntax: "A", properties: [str("only")] },
          },
          {
            name: "b",
            optional: false,
            type: { kind: "object", syntax: "B", properties: [str("other")] },
          },
        ],
      },
    };
    expect(isCombinable(fanOutGroups(propDef))).toBe(false);
  });
});

/** The expanded tree a real run would send for the odin shape, all agreeing. */
function odinInput(): ExecutionInput {
  const member = (
    extra: Record<string, ExecutionInput> = {},
  ): ExecutionInput => ({
    kind: "object",
    properties: {
      db: { kind: "resource", uri: ".evalution/playground/db.ts#db" },
      workspaceId: {
        kind: "value",
        value: { kind: "primitive", value: "ws_internal_default" },
      },
      ...extra,
    },
  });
  const rootTaskId: ExecutionInput = {
    kind: "value",
    value: { kind: "primitive", value: "tsk_x" },
  };
  return {
    kind: "object",
    properties: {
      list_tasks: member({ rootTaskId }),
      create_task: member({ rootTaskId }),
      update_task: member(),
      post_message: member({
        runId: { kind: "value", value: { kind: "primitive", value: "run_1" } },
      }),
    },
  };
}

describe("expand / collapse", () => {
  it("expand produces per-member objects containing only the fields that member declares", () => {
    const groups = fanOutGroups(TOOLS_CONTEXT);
    const combined = collapse(groups, odinInput())!;
    const out = expand(groups, combined) as Extract<
      ExecutionInput,
      { kind: "object" }
    >;

    const updateTask = out.properties.update_task as Extract<
      ExecutionInput,
      { kind: "object" }
    >;
    expect(Object.keys(updateTask.properties).sort()).toEqual([
      "db",
      "workspaceId",
    ]);
    const postMessage = out.properties.post_message as Extract<
      ExecutionInput,
      { kind: "object" }
    >;
    expect(Object.keys(postMessage.properties).sort()).toEqual([
      "db",
      "runId",
      "workspaceId",
    ]);
  });

  it("expand ∘ collapse is identity on an agreeing tree", () => {
    const groups = fanOutGroups(TOOLS_CONTEXT);
    const input = odinInput();
    const combined = collapse(groups, input)!;
    expect(combined).not.toBeNull();
    expect(expand(groups, combined)).toEqual(input);
  });

  it("collapse returns null when a group's members disagree", () => {
    const groups = fanOutGroups(TOOLS_CONTEXT);
    const input = odinInput() as Extract<ExecutionInput, { kind: "object" }>;
    // Give `update_task` a different workspaceId than everyone else.
    const updateTask = input.properties.update_task as Extract<
      ExecutionInput,
      { kind: "object" }
    >;
    updateTask.properties.workspaceId = {
      kind: "value",
      value: { kind: "primitive", value: "ws_other" },
    };

    expect(collapse(groups, input)).toBeNull();
  });

  it("a slot with a non-object member leaves it ungrouped", () => {
    const propDef: PropDefinition = {
      name: "x",
      optional: false,
      type: {
        kind: "object",
        syntax: "X",
        properties: [
          str("sibling"),
          {
            name: "a",
            optional: false,
            type: { kind: "object", syntax: "A", properties: [str("id")] },
          },
          {
            name: "b",
            optional: false,
            type: { kind: "object", syntax: "B", properties: [str("id")] },
          },
        ],
      },
    };
    // `sibling` never appears in any group, and `collapse`/`expand` never
    // reference it — it simply isn't part of what combined mode touches.
    const groups = fanOutGroups(propDef);
    expect(groups.every(g => g.name !== "sibling")).toBe(true);
  });
});

describe("collapseLossy", () => {
  it("keeps the first member's value and names the ones it overwrites", () => {
    const groups = fanOutGroups(TOOLS_CONTEXT);
    const input = odinInput() as Extract<ExecutionInput, { kind: "object" }>;
    const updateTask = input.properties.update_task as Extract<
      ExecutionInput,
      { kind: "object" }
    >;
    updateTask.properties.workspaceId = {
      kind: "value",
      value: { kind: "primitive", value: "ws_other" },
    };

    const { selection, overwritten } = collapseLossy(groups, input);
    expect(selection.fields.workspaceId.value).toEqual({
      kind: "primitive",
      value: "ws_internal_default",
    });
    expect(overwritten.workspaceId).toEqual(["update_task"]);
  });
});

describe("resolveLayout", () => {
  const groups = fanOutGroups(TOOLS_CONTEXT);

  it("opens expanded with no hint and no stored choice", () => {
    expect(resolveLayout(groups, undefined, undefined, undefined)).toBe(
      "expanded",
    );
  });

  it("opens combined when the adapter hints it", () => {
    expect(resolveLayout(groups, undefined, undefined, "combined")).toBe(
      "combined",
    );
  });

  it("a stored explicit expanded choice beats the hint", () => {
    expect(resolveLayout(groups, undefined, "expanded", "combined")).toBe(
      "expanded",
    );
  });

  it("stored inputs that disagree open expanded despite the hint", () => {
    const input = odinInput() as Extract<ExecutionInput, { kind: "object" }>;
    const updateTask = input.properties.update_task as Extract<
      ExecutionInput,
      { kind: "object" }
    >;
    updateTask.properties.workspaceId = {
      kind: "value",
      value: { kind: "primitive", value: "ws_other" },
    };
    expect(resolveLayout(groups, input, undefined, "combined")).toBe(
      "expanded",
    );
  });
});
