// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import type { PropDefinition } from "../shared/types.ts";
import {
  collectInputSlots,
  type InputSource,
  matchSourcesToSlots,
  resolveExecutionInput,
  resolveExecutionInputs,
} from "./execution-inputs.ts";

const str = (name: string, optional = false): PropDefinition => ({
  name,
  type: { kind: "primitive", syntax: "string", base: "string" },
  optional,
});

describe("collectInputSlots", () => {
  it("flattens object properties into dotted paths", () => {
    const slots = collectInputSlots([
      str("taskId"),
      {
        name: "toolsContext",
        optional: false,
        type: {
          kind: "object",
          syntax: "ToolsContext",
          properties: [
            {
              name: "list_tasks",
              optional: false,
              type: {
                kind: "object",
                syntax: "Ctx",
                properties: [
                  {
                    name: "db",
                    optional: false,
                    type: { kind: "opaque", syntax: "Db" },
                  },
                  str("workspaceId"),
                ],
              },
            },
          ],
        },
      },
    ]);

    expect(slots.map(s => s.path)).toEqual([
      "taskId",
      "toolsContext",
      "toolsContext.list_tasks",
      "toolsContext.list_tasks.db",
      "toolsContext.list_tasks.workspaceId",
    ]);
  });
});

describe("matchSourcesToSlots", () => {
  const slots = collectInputSlots([
    str("taskId"),
    {
      name: "ctx",
      optional: false,
      type: {
        kind: "object",
        syntax: "Ctx",
        properties: [
          {
            name: "db",
            optional: false,
            type: { kind: "opaque", syntax: "Db" },
          },
          str("taskId"),
        ],
      },
    },
  ]);

  it("matches by name when no checker opinion is available", () => {
    const sources: InputSource[] = [{ uri: "pg.ts#taskId", key: "taskId" }];
    // Both slots are *named* taskId, at different depths.
    expect(matchSourcesToSlots(slots, sources)).toEqual({
      taskId: ["pg.ts#taskId"],
      "ctx.taskId": ["pg.ts#taskId"],
    });
  });

  it("prefers an explicit `for` over the name rule, and excludes other slots", () => {
    const sources: InputSource[] = [
      { uri: "pg.ts#taskId", key: "taskId", for: "ctx.taskId" },
    ];
    // Pinning one slot is a statement about where the source belongs, so the
    // same-named top-level slot must stop being offered it.
    expect(matchSourcesToSlots(slots, sources)).toEqual({
      "ctx.taskId": ["pg.ts#taskId"],
    });
  });

  it("accepts a `for` prefixed with the prompt name", () => {
    const sources: InputSource[] = [
      { uri: "pg.ts#db", key: "db", for: "orchestrate.ctx.db" },
    ];
    expect(matchSourcesToSlots(slots, sources, "orchestrate")).toEqual({
      "ctx.db": ["pg.ts#db"],
    });
  });

  it("prefers the type rule over the name rule when the checker has an opinion", () => {
    const sources: InputSource[] = [
      {
        uri: "pg.ts#taskId",
        key: "taskId",
        // The checker says this fits the nested slot but not the top-level one
        // — a name-only rule would have got that backwards for both.
        fitsType: (_t, path) => path === "ctx.db",
      },
    ];
    expect(matchSourcesToSlots(slots, sources)).toEqual({
      "ctx.db": ["pg.ts#taskId"],
    });
  });

  it("lets one value's `for` pin only that value, leaving its sibling value matched by name", () => {
    // Two sources sharing one resource — a resource's `RegisteredSource`s all
    // resolve through the same `create()`, but they are independent entries
    // to the matcher, and pinning one must not touch the other.
    const sources: InputSource[] = [
      { uri: "pg.ts#taskA.taskId", key: "taskId", for: "ctx.taskId" },
      { uri: "pg.ts#taskA.db", key: "db" },
    ];
    expect(matchSourcesToSlots(slots, sources)).toEqual({
      "ctx.taskId": ["pg.ts#taskA.taskId"],
      "ctx.db": ["pg.ts#taskA.db"],
    });
  });

  it("offers a source beside an editable slot rather than instead of it", () => {
    // Matching says what *can* fill a slot; whether the slot has an editor is
    // decided from its type alone. A string slot stays a string slot.
    const sources: InputSource[] = [{ uri: "pg.ts#taskId", key: "taskId" }];
    const matched = matchSourcesToSlots(slots, sources);
    const taskIdSlot = slots.find(s => s.path === "taskId")!;
    expect(taskIdSlot.type.kind).toBe("primitive");
    expect(matched.taskId).toEqual(["pg.ts#taskId"]);
  });
});

describe("resolveExecutionInput", () => {
  it("materializes a value", async () => {
    expect(
      await resolveExecutionInput({
        kind: "value",
        value: { kind: "primitive", value: "Ada" },
      }),
    ).toBe("Ada");
  });

  it("grafts a resource into one field of an otherwise hand-edited object", async () => {
    const resolved = await resolveExecutionInput(
      {
        kind: "object",
        properties: {
          workspaceId: {
            kind: "value",
            value: { kind: "primitive", value: "ws_1" },
          },
          db: { kind: "resource", uri: "pg.ts#db" },
        },
      },
      async uri => ({ handle: uri }),
    );
    expect(resolved).toEqual({
      workspaceId: "ws_1",
      db: { handle: "pg.ts#db" },
    });
  });

  it("materializes a value whose functionCall is bound to an import", async () => {
    // This is the case that cannot work in a browser at all: `materializeValue`
    // does `await import(spec.from)` for an import-bound callee, and the panel
    // used to call it client-side. Moving resolution server-side fixes it as a
    // side effect of enabling resources.
    const resolved = await resolveExecutionInput({
      kind: "value",
      value: {
        kind: "functionCall",
        callee: "join",
        binding: { kind: "import", spec: { name: "join", from: "node:path" } },
        args: [
          { kind: "primitive", value: "a" },
          { kind: "primitive", value: "b" },
        ],
      },
    });
    expect(resolved).toBe("a/b");
  });

  it("rejects a dataset input with a clear not-implemented error", async () => {
    // The variant exists so the resolver, the matching layer, and the panel are
    // all built over the union before `DatasetProvider` lands — but it must say
    // so rather than crash on an unhandled shape.
    await expect(
      resolveExecutionInput({ kind: "dataset", uri: "rows/1#col" }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("explains itself when a resource is referenced with no resolver", async () => {
    await expect(
      resolveExecutionInput({ kind: "resource", uri: "pg.ts#db" }),
    ).rejects.toThrow(/does not offer resources/);
  });
});

describe("resolveExecutionInputs", () => {
  it("resolves both halves through one resolver, so a shared resource is created once", async () => {
    const created = vi.fn(async (uri: string) => ({ uri }));
    // A memoizing resolver is the registry's lease in production; here the
    // point is only that both halves go through the *same* one.
    const memo = new Map<string, Promise<unknown>>();
    const resolveResource = (uri: string) => {
      const existing = memo.get(uri);
      if (existing) return existing;
      const pending = created(uri);
      memo.set(uri, pending);
      return pending;
    };

    const { functionParams, executeValues } = await resolveExecutionInputs(
      {
        functionInputs: [{ kind: "resource", uri: "pg.ts#db" }],
        executeInputs: {
          toolsContext: {
            kind: "object",
            properties: { db: { kind: "resource", uri: "pg.ts#db" } },
          },
        },
      },
      resolveResource,
    );

    expect(created).toHaveBeenCalledTimes(1);
    expect(functionParams[0]).toBe(executeValues.toolsContext.db);
  });
});
