// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type {
  ExecutionInput,
  PropDefinition,
  RunResources,
} from "../shared/types.ts";
import {
  collectInputSlots,
  findInputCycle,
  type InputBindings,
  type InputSource,
  type InstanceResolver,
  inputReferenceProblems,
  matchSourcesToSlots,
  namedBindings,
  resolveExecutionInput,
  resolveExecutionInputs,
  stampReceipts,
} from "./execution-inputs.ts";
import type { DeclaredInstance } from "./playground/resource-registry.ts";

/**
 * An in-memory {@link InstanceResolver}: memoizes by name the way the lease
 * does, creating each instance with `create` — by default, a record of what
 * it was declared with and the arguments it resolved to.
 */
function fakeResolver(
  create: (
    name: string,
    decl: DeclaredInstance,
    args: Record<string, unknown> | undefined,
  ) => unknown = (name, decl, args) => ({ name, uri: decl.uri, args }),
) {
  const declared = new Map<string, DeclaredInstance>();
  const memo = new Map<string, Promise<unknown>>();
  const created: string[] = [];
  const resolver: InstanceResolver = {
    declare: async instances => {
      for (const [name, decl] of Object.entries(instances)) {
        declared.set(name, decl);
      }
    },
    acquire: async (name, output) => {
      let pending = memo.get(name);
      if (!pending) {
        const decl = declared.get(name);
        if (!decl) throw new Error(`No resource instance named '${name}'`);
        created.push(name);
        pending = (async () =>
          create(name, decl, await decl.binding?.resolve?.()))();
        memo.set(name, pending);
      }
      const value: any = await pending;
      return output === undefined ? value : value?.[output];
    },
  };
  return { resolver, created, declared };
}

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
    const { resolver } = fakeResolver(name => ({ handle: name }));
    await resolver.declare({ db: { uri: "pg.ts#db" } });
    const resolved = await resolveExecutionInput(
      {
        kind: "object",
        properties: {
          workspaceId: {
            kind: "value",
            value: { kind: "primitive", value: "ws_1" },
          },
          db: { kind: "instance", name: "db" },
        },
      },
      resolver,
    );
    expect(resolved).toEqual({
      workspaceId: "ws_1",
      db: { handle: "db" },
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

  it("rejects a dataset input outside an eval run, saying why", async () => {
    await expect(
      resolveExecutionInput({ kind: "dataset", field: "0" }),
    ).rejects.toThrow(/only be bound in an eval run/);
  });

  it("explains itself when a resource is referenced with no resolver", async () => {
    await expect(
      resolveExecutionInput({ kind: "instance", name: "db" }),
    ).rejects.toThrow(/does not offer resources/);
  });
});

describe("resolveExecutionInputs", () => {
  it("resolves both halves through one resolver, so a shared instance is created once", async () => {
    const { resolver, created } = fakeResolver();
    const { functionParams, executeValues } = await resolveExecutionInputs(
      {
        functionInputs: [{ kind: "instance", name: "db" }],
        executeInputs: {
          toolsContext: {
            kind: "object",
            properties: { db: { kind: "instance", name: "db" } },
          },
        },
        resources: { db: { uri: "pg.ts#db" } },
      },
      resolver,
    );

    expect(created).toEqual(["db"]);
    expect(functionParams[0]).toBe(executeValues.toolsContext.db);
  });

  it("creates every declared instance, even one no slot names", async () => {
    const { resolver, created } = fakeResolver();
    await resolveExecutionInputs(
      {
        functionInputs: [],
        resources: {
          db: { uri: "pg.ts#db" },
          seeded: { uri: "pg.ts#seeded" },
        },
      },
      resolver,
    );
    expect(created.sort()).toEqual(["db", "seeded"]);
  });

  it("resolves an instance's arguments, which may name another instance's output", async () => {
    const { resolver } = fakeResolver((name, _decl, args) =>
      name === "root" ? { id: "tsk_root" } : { id: "tsk_child", ...args },
    );
    const { functionParams } = await resolveExecutionInputs(
      {
        functionInputs: [{ kind: "instance", name: "child" }],
        resources: {
          root: { uri: "pg.ts#task" },
          child: {
            uri: "pg.ts#task",
            args: {
              title: {
                kind: "value",
                value: { kind: "primitive", value: "Child" },
              },
              parentId: { kind: "instance", name: "root", output: "id" },
            },
          },
        },
      },
      resolver,
    );
    expect(functionParams[0]).toEqual({
      id: "tsk_child",
      title: "Child",
      parentId: "tsk_root",
    });
  });

  it("declares an instance with no arguments or receipt without a binding", async () => {
    const { resolver, declared } = fakeResolver();
    await resolveExecutionInputs(
      { resources: { db: { uri: "pg.ts#db" } } },
      resolver,
    );
    expect(declared.get("db")).toStrictEqual({ uri: "pg.ts#db" });
  });

  it("passes a recorded receipt through to the resolver on a replay", async () => {
    const { resolver, declared } = fakeResolver();
    await resolveExecutionInputs(
      {
        resources: {
          seeded: { uri: "pg.ts#seeded", receipt: { taskId: "tsk_abc" } },
        },
      },
      resolver,
    );
    expect(declared.get("seeded")?.binding?.receipt).toEqual({
      taskId: "tsk_abc",
    });
    expect(declared.get("seeded")?.binding?.resolve).toBeUndefined();
  });

  it("explains itself when a run declares instances but the provider offers no resources", async () => {
    await expect(
      resolveExecutionInputs({ resources: { db: { uri: "pg.ts#db" } } }),
    ).rejects.toThrow(/Cannot create resource 'db'.*does not offer resources/);
  });
});

describe("stampReceipts", () => {
  it("sets each instance's receipt by name", () => {
    const resources: RunResources = {
      db: { uri: "pg.ts#db" },
      seeded: {
        uri: "pg.ts#seeded",
        args: {
          title: { kind: "value", value: { kind: "primitive", value: "T" } },
        },
      },
    };
    expect(
      stampReceipts(resources, {
        db: "db-receipt",
        seeded: { taskId: "tsk_abc" },
      }),
    ).toEqual({
      db: { uri: "pg.ts#db", receipt: "db-receipt" },
      seeded: { ...resources.seeded, receipt: { taskId: "tsk_abc" } },
    });
  });

  it("drops a replayed receipt that this run didn't reproduce", () => {
    expect(
      stampReceipts({ db: { uri: "pg.ts#db", receipt: "old-receipt" } }, {}),
    ).toStrictEqual({ db: { uri: "pg.ts#db" } });
  });

  it("returns nothing for a run that declared no instances", () => {
    expect(stampReceipts(undefined, { db: "r" })).toBeUndefined();
  });
});

const text = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

describe("dataset and input references", () => {
  it("resolves a dataset reference to its row's cell, recursively", async () => {
    const row = {
      cells: {
        "0": text("Set up CI"),
        "1": { kind: "instance", name: "db" } as ExecutionInput,
      },
    };
    const { resolver: resolve } = fakeResolver(name => `created:${name}`);
    await resolve.declare({ db: { uri: "pg.ts#db" } });
    expect(
      await resolveExecutionInput({ kind: "dataset", field: "0" }, resolve, {
        row,
      }),
    ).toBe("Set up CI");
    expect(
      await resolveExecutionInput({ kind: "dataset", field: "1" }, resolve, {
        row,
      }),
    ).toBe("created:db");
  });

  it("resolves a column the row leaves empty to nothing", async () => {
    expect(
      await resolveExecutionInput({ kind: "dataset", field: "9" }, undefined, {
        row: { cells: {} },
      }),
    ).toBeUndefined();
  });

  it("binds a resource argument to a column", async () => {
    const seen: unknown[] = [];
    const { resolver } = fakeResolver((_name, _decl, args) => {
      seen.push(args);
      return "task";
    });
    await resolveExecutionInputs(
      {
        resources: {
          task: {
            uri: "pg.ts#seededTask",
            args: { title: { kind: "dataset", field: "0" } },
          },
        },
      },
      resolver,
      { row: { cells: { "0": text("Plan it") } } },
    );
    expect(seen).toEqual([{ title: "Plan it" }]);
  });

  it("resolves an input reference to the other slot's value, through the same resolver", async () => {
    const bindings: InputBindings = {
      functionInputs: {
        taskId: { kind: "instance", name: "seeded", output: "taskId" },
      },
      executeInputs: {
        toolsContext: {
          kind: "object",
          properties: {
            list_tasks: {
              kind: "object",
              properties: {
                rootTaskId: { kind: "input", half: "function", path: "taskId" },
              },
            },
          },
        },
      },
    };
    const { resolver, created } = fakeResolver(() => ({ taskId: "tsk_1" }));
    const { functionParams, executeValues } = await resolveExecutionInputs(
      {
        functionInputs: [bindings.functionInputs.taskId],
        executeInputs: bindings.executeInputs,
        resources: { seeded: { uri: "pg.ts#seeded" } },
      },
      resolver,
      { bindings },
    );
    expect(functionParams).toEqual(["tsk_1"]);
    expect(executeValues.toolsContext.list_tasks.rootTaskId).toBe("tsk_1");
    expect(created).toEqual(["seeded"]);
  });

  it("reads a nested path through a typed-in object, and off a resolved value", async () => {
    const bindings: InputBindings = {
      functionInputs: {
        info: {
          kind: "value",
          value: {
            kind: "object",
            properties: { title: { kind: "primitive", value: "T" } },
          },
        },
        seeded: { kind: "instance", name: "seeded" },
      },
      executeInputs: {},
    };
    const { resolver: resolve } = fakeResolver(() => ({ taskId: "tsk_9" }));
    await resolve.declare({ seeded: { uri: "pg.ts#seeded" } });
    expect(
      await resolveExecutionInput(
        { kind: "input", half: "function", path: "info.title" },
        resolve,
        { bindings },
      ),
    ).toBe("T");
    expect(
      await resolveExecutionInput(
        { kind: "input", half: "function", path: "seeded.taskId" },
        resolve,
        { bindings },
      ),
    ).toBe("tsk_9");
  });

  it("fails an input reference with no bindings to read, saying so", async () => {
    await expect(
      resolveExecutionInput({ kind: "input", half: "function", path: "a" }),
    ).rejects.toThrow(/no slot bindings/);
  });

  it("catches a cycle at run time that only a dataset cell closes", async () => {
    const bindings: InputBindings = {
      functionInputs: {
        a: { kind: "dataset", field: "0" },
        b: { kind: "input", half: "function", path: "a" },
      },
      executeInputs: {},
    };
    await expect(
      resolveExecutionInput(bindings.functionInputs.b, undefined, {
        bindings,
        row: {
          cells: { "0": { kind: "input", half: "function", path: "b" } },
        },
      }),
    ).rejects.toThrow(/Input cycle: a → b → a|Input cycle/);
  });

  it("names a positional request's inputs by parameter", () => {
    expect(
      namedBindings([str("a"), str("b")], {
        functionInputs: [text("x")],
        executeInputs: { ctx: text("y") },
      }),
    ).toEqual({
      functionInputs: { a: text("x") },
      executeInputs: { ctx: text("y") },
    });
  });
});

describe("findInputCycle", () => {
  it("finds a direct cycle, naming the slots", () => {
    expect(
      findInputCycle({
        functionInputs: {
          a: { kind: "input", half: "function", path: "b" },
          b: { kind: "input", half: "function", path: "a" },
        },
        executeInputs: {},
      }),
    ).toEqual(["a", "b", "a"]);
  });

  it("finds a slot that names something inside itself", () => {
    expect(
      findInputCycle({
        functionInputs: {
          a: {
            kind: "object",
            properties: { x: { kind: "input", half: "function", path: "a" } },
          },
        },
        executeInputs: {},
      }),
    ).toEqual(["a.x", "a.x"]);
  });

  it("follows references in a resource instance's arguments", () => {
    expect(
      findInputCycle({
        resources: {
          seeded: {
            uri: "pg.ts#seeded",
            args: {
              root: { kind: "input", half: "execute", path: "ctx.root" },
            },
          },
        },
        functionInputs: {
          taskId: { kind: "instance", name: "seeded" },
        },
        executeInputs: {
          ctx: {
            kind: "object",
            properties: {
              root: { kind: "input", half: "function", path: "taskId" },
            },
          },
        },
      }),
    ).toBeDefined();
  });

  it("finds two instances that each take the other's output", () => {
    expect(
      findInputCycle({
        resources: {
          a: {
            uri: "pg.ts#task",
            args: { parentId: { kind: "instance", name: "b", output: "id" } },
          },
          b: {
            uri: "pg.ts#task",
            args: { parentId: { kind: "instance", name: "a", output: "id" } },
          },
        },
        functionInputs: {},
        executeInputs: {},
      }),
    ).toEqual(["resource 'a'", "resource 'b'", "resource 'a'"]);
  });

  it("accepts one instance taking another of the same resource's output", () => {
    expect(
      findInputCycle({
        resources: {
          root: { uri: "pg.ts#task" },
          child: {
            uri: "pg.ts#task",
            args: {
              parentId: { kind: "instance", name: "root", output: "id" },
            },
          },
        },
        functionInputs: { taskId: { kind: "instance", name: "child" } },
        executeInputs: {},
      }),
    ).toBeUndefined();
  });

  it("accepts references that don't loop", () => {
    expect(
      findInputCycle({
        functionInputs: {
          taskId: text("t"),
          other: { kind: "input", half: "function", path: "taskId" },
        },
        executeInputs: {
          ctx: { kind: "input", half: "function", path: "other" },
        },
      }),
    ).toBeUndefined();
  });
});

describe("inputReferenceProblems", () => {
  it("names a target the prompt doesn't have, and a cycle", () => {
    const problems = inputReferenceProblems(
      {
        functionInputs: {
          a: { kind: "input", half: "function", path: "missing" },
          b: { kind: "input", half: "function", path: "c" },
          c: { kind: "input", half: "function", path: "b" },
        },
        executeInputs: {},
      },
      { functionParameters: [str("a"), str("b"), str("c")] },
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/'missing'/);
    expect(problems[1]).toMatch(/cycle: b → c → b/);
  });

  it("names an instance the run doesn't declare, unless rows may declare it", () => {
    const bindings: InputBindings = {
      functionInputs: { a: { kind: "instance", name: "db" } },
      executeInputs: {},
      resources: {
        seeded: {
          uri: "pg.ts#seeded",
          args: { db: { kind: "instance", name: "other" } },
        },
      },
    };
    const signature = { functionParameters: [str("a")] };
    expect(inputReferenceProblems(bindings, signature)).toEqual([
      "'a' names resource 'db', which this run doesn't declare",
      "resource 'seeded' names resource 'other', which this run doesn't declare",
    ]);
    expect(
      inputReferenceProblems(bindings, signature, {
        undeclaredInstances: true,
      }),
    ).toEqual([]);
  });

  it("checks an `input` reference among an instance's arguments", () => {
    expect(
      inputReferenceProblems(
        {
          functionInputs: {},
          executeInputs: {},
          resources: {
            seeded: {
              uri: "pg.ts#seeded",
              args: {
                title: { kind: "input", half: "function", path: "nope" },
              },
            },
          },
        },
        { functionParameters: [str("a")] },
      ),
    ).toEqual([
      "resource 'seeded' names input 'nope', which the prompt doesn't have",
    ]);
  });
});
