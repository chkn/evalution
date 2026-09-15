// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import type { ExecutionInput, PropDefinition } from "../shared/types.ts";
import {
  canonicalArgumentKey,
  collectInputSlots,
  type InputSource,
  matchSourcesToSlots,
  resolveExecutionInput,
  resolveExecutionInputs,
  stampReceipts,
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

  it("resolves a resource used both as an argument and as a prompt input to one instance per run", async () => {
    const created = vi.fn(async (uri: string) => ({ uri }));
    const memo = new Map<string, Promise<unknown>>();
    const resolveResource = (uri: string) => {
      const existing = memo.get(uri);
      if (existing) return existing;
      const pending = created(uri);
      memo.set(uri, pending);
      return pending;
    };

    const dbRef: ExecutionInput = { kind: "resource", uri: "pg.ts#db" };
    const { functionParams, executeValues } = await resolveExecutionInputs(
      {
        // `db` filling a prompt slot directly...
        functionInputs: [dbRef],
        // ...and filling an argument of a different resource.
        executeInputs: {
          seeded: {
            kind: "resource",
            uri: "pg.ts#seeded",
            args: { db: dbRef },
          },
        },
      },
      resolveResource,
    );

    expect(created).toHaveBeenCalledTimes(2); // db, seeded — not db twice
    expect(functionParams[0]).toBe(await memo.get("pg.ts#db"));
    expect(executeValues.seeded).toEqual({ uri: "pg.ts#seeded" });
  });
});

describe("canonicalArgumentKey", () => {
  it("encodes absent args and an empty object identically", () => {
    expect(canonicalArgumentKey(undefined)).toBe("");
    expect(canonicalArgumentKey({})).toBe("");
  });

  it("is insensitive to key order", () => {
    const a = canonicalArgumentKey({
      title: { kind: "value", value: { kind: "primitive", value: "x" } },
      status: { kind: "value", value: { kind: "primitive", value: "y" } },
    });
    const b = canonicalArgumentKey({
      status: { kind: "value", value: { kind: "primitive", value: "y" } },
      title: { kind: "value", value: { kind: "primitive", value: "x" } },
    });
    expect(a).toBe(b);
  });

  it("differs for genuinely different arguments", () => {
    const a = canonicalArgumentKey({
      title: { kind: "value", value: { kind: "primitive", value: "x" } },
    });
    const b = canonicalArgumentKey({
      title: { kind: "value", value: { kind: "primitive", value: "y" } },
    });
    expect(a).not.toBe(b);
  });
});

describe("resource arguments and receipts on resolveExecutionInput (specs/resource-arguments.md §C, §D)", () => {
  it("builds a binding whose key matches canonicalArgumentKey and resolves nested args recursively", async () => {
    const resolveResource = vi.fn(async (uri: string, binding?: any) => ({
      uri,
      args: binding ? await binding.resolve() : undefined,
    }));

    const args = {
      title: {
        kind: "value" as const,
        value: { kind: "primitive" as const, value: "Todo app" },
      },
      owner: { kind: "resource" as const, uri: "pg.ts#owner" },
    };
    const result: any = await resolveExecutionInput(
      { kind: "resource", uri: "pg.ts#seeded", args },
      resolveResource,
    );

    expect(resolveResource).toHaveBeenCalledWith(
      "pg.ts#seeded",
      expect.objectContaining({ key: canonicalArgumentKey(args) }),
    );
    expect(result.args).toEqual({
      title: "Todo app",
      owner: { uri: "pg.ts#owner", args: undefined },
    });
  });

  it("calls the resolver with no binding at all for a reference with neither args nor a receipt", async () => {
    const resolveResource = vi.fn(async (uri: string) => uri);
    await resolveExecutionInput(
      { kind: "resource", uri: "pg.ts#db" },
      resolveResource,
    );
    expect(resolveResource).toHaveBeenCalledWith("pg.ts#db");
    expect(resolveResource).toHaveBeenCalledTimes(1);
    expect(resolveResource.mock.calls[0]).toHaveLength(1);
  });

  it("passes a recorded receipt through to the resolver on a replay", async () => {
    const resolveResource = vi.fn(
      async (_uri: string, binding?: any) => binding?.receipt,
    );
    const result = await resolveExecutionInput(
      { kind: "resource", uri: "pg.ts#seeded", receipt: { taskId: "tsk_abc" } },
      resolveResource,
    );
    expect(result).toEqual({ taskId: "tsk_abc" });
  });
});

describe("stampReceipts", () => {
  it("sets a receipt on a resource reference by its uri when it has no arguments", () => {
    const stamped = stampReceipts(
      { functionInputs: [{ kind: "resource", uri: "pg.ts#db" }] },
      { "pg.ts#db": "db-receipt" },
    );
    expect(stamped.functionInputs?.[0]).toMatchObject({
      kind: "resource",
      uri: "pg.ts#db",
      receipt: "db-receipt",
    });
  });

  it("sets a receipt keyed by uri@key when the reference has arguments", () => {
    const args = {
      title: {
        kind: "value" as const,
        value: { kind: "primitive" as const, value: "Todo app" },
      },
    };
    const key = canonicalArgumentKey(args);
    const stamped = stampReceipts(
      {
        executeInputs: {
          seeded: { kind: "resource", uri: "pg.ts#seeded", args },
        },
      },
      { [`pg.ts#seeded@${key}`]: { taskId: "tsk_abc" } },
    );
    expect(stamped.executeInputs?.seeded).toMatchObject({
      receipt: { taskId: "tsk_abc" },
    });
  });

  it("stamps a resource nested inside an object input", () => {
    const stamped = stampReceipts(
      {
        executeInputs: {
          toolsContext: {
            kind: "object",
            properties: { db: { kind: "resource", uri: "pg.ts#db" } },
          },
        },
      },
      { "pg.ts#db": "db-receipt" },
    );
    expect(stamped.executeInputs?.toolsContext).toEqual({
      kind: "object",
      properties: {
        db: {
          kind: "resource",
          uri: "pg.ts#db",
          args: undefined,
          receipt: "db-receipt",
        },
      },
    });
  });

  it("stamps a resource nested inside another resource's own args", () => {
    const args = { owner: { kind: "resource" as const, uri: "pg.ts#owner" } };
    const stamped = stampReceipts(
      {
        functionInputs: [{ kind: "resource", uri: "pg.ts#seeded", args }],
      },
      { "pg.ts#owner": "owner-receipt" },
    );
    const seeded = stamped.functionInputs?.[0] as Extract<
      ExecutionInput,
      { kind: "resource" }
    >;
    expect(seeded.args?.owner).toMatchObject({ receipt: "owner-receipt" });
  });

  it("drops a replayed receipt that this run didn't reproduce", () => {
    const stamped = stampReceipts(
      {
        functionInputs: [
          { kind: "resource", uri: "pg.ts#db", receipt: "old-receipt" },
        ],
      },
      {},
    );
    expect(stamped.functionInputs?.[0]).toStrictEqual({
      kind: "resource",
      uri: "pg.ts#db",
    });
  });

  it("leaves inputs untouched when no receipts were produced", () => {
    const inputs = {
      functionInputs: [{ kind: "resource" as const, uri: "pg.ts#db" }],
    };
    expect(stampReceipts(inputs, undefined)).toBe(inputs);
    expect(stampReceipts(inputs, {})).not.toBe(inputs);
    expect(stampReceipts(inputs, {}).functionInputs?.[0]).toMatchObject({
      uri: "pg.ts#db",
    });
  });
});
