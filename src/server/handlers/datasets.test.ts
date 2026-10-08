// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { runDatasetMigrations } from "../../dataset/db/migrate.ts";
import { TursoDatasetProvider } from "../../dataset/turso-dataset-provider.ts";
import type { ExecutionInput, PropDefinition } from "../../shared/types.ts";
import {
  type FieldSourcePrompt,
  handleAddField,
  handleUpdateRows,
  type LookupFieldSourcePrompt,
  primitiveFieldDef,
} from "./datasets.ts";

const span = { start: 10, end: 20 };

const TASK_ID: PropDefinition = {
  name: "taskId",
  type: { kind: "primitive", syntax: "TaskId", base: "string" },
  optional: false,
  description: "The task to plan.",
  valueSpan: span,
  fullSpan: span,
};

const THREAD_MSGS: PropDefinition = {
  name: "threadMsgs",
  type: {
    kind: "array",
    syntax: 'readonly Pick<ThreadMessage, "excerpt">[]',
    element: {
      name: "",
      type: { kind: "primitive", syntax: "string" },
      optional: false,
    },
  },
  optional: false,
};

const TOOLS_CONTEXT: PropDefinition = {
  name: "toolsContext",
  type: {
    kind: "object",
    syntax: "ToolsContext",
    properties: [
      {
        name: "db",
        type: { kind: "primitive", syntax: "Db" },
        optional: false,
      },
    ],
  },
  optional: false,
};

const PROMPTS: Record<string, FieldSourcePrompt> = {
  "files/odin.ts#plan": {
    functionParameters: [TASK_ID, THREAD_MSGS],
    executeParameters: [TOOLS_CONTEXT],
  },
};

const lookup: LookupFieldSourcePrompt = async (providerId, promptId) =>
  PROMPTS[`${providerId}/${promptId}`];

describe("handleAddField", () => {
  let client: Database | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function setup() {
    client = await connect({ path: ":memory:", url: () => null });
    await runDatasetMigrations(drizzle({ client }));
    const provider = new TursoDatasetProvider({ client });
    const dataset = await provider.createDataset({
      name: "Odin",
      fields: [{ def: primitiveFieldDef("title", "string") }],
    });
    const add = (body: unknown, datasetId = dataset.id) =>
      handleAddField(provider, datasetId, body, lookup, async (p, uri) =>
        p === "files" && uri === ".evalution/playground/checks.ts#titled"
          ? { parameters: [primitive("title", "string")] }
          : undefined,
      );
    return { provider, dataset, add };
  }

  it("copies a check parameter's definition", async () => {
    const { add } = await setup();
    const res = await add({
      from: {
        providerId: "files",
        checkUri: ".evalution/playground/checks.ts#titled",
        path: "title",
      },
      name: "expectedTitle",
    });
    expect(res).toMatchObject({
      status: 201,
      body: { def: { name: "expectedTitle", type: { base: "string" } } },
    });
  });

  it("builds a primitive field's definition from a name and type", async () => {
    const { provider, dataset, add } = await setup();
    for (const type of ["string", "number", "boolean"] as const) {
      const res = await add({ name: `  ${type}Field `, type });
      expect(res).toEqual({
        status: 201,
        body: {
          id: expect.any(String),
          def: {
            name: `${type}Field`,
            optional: true,
            type: { kind: "primitive", syntax: type, base: type },
          },
          added: true,
        },
      });
    }
    const fields = (await provider.getDataset(dataset.id))?.fields ?? [];
    expect(fields.map(f => f.id)).toEqual(["0", "1", "2", "3"]);
  });

  it.each([
    ["no body", undefined, /body must be/],
    ["no name", { type: "string" }, /name must be/],
    ["a blank name", { name: "  ", type: "string" }, /name must be/],
    ["an unknown type", { name: "x", type: "Task" }, /type must be one of/],
    ["no type", { name: "x" }, /type must be one of/],
    ["a hand-written definition", { def: TASK_ID }, /built by the server/],
    [
      "both type and from",
      {
        name: "x",
        type: "string",
        from: { providerId: "files", promptId: "odin.ts#plan", path: "taskId" },
      },
      /not both/,
    ],
  ])("rejects %s with a 400", async (_label, body, message) => {
    const { add } = await setup();
    const res = await add(body);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(message);
  });

  it("rejects a field that already exists by name and type", async () => {
    const { add } = await setup();
    const res = await add({ name: "title", type: "string" });
    expect(res).toEqual({
      status: 400,
      body: { error: "`title: string` already exists" },
    });
    // The same name with another type is another field.
    expect((await add({ name: "title", type: "number" })).status).toBe(201);
  });

  it("responds 404 for an unknown dataset", async () => {
    const { add } = await setup();
    const res = await add({ name: "x", type: "string" }, "missing");
    expect(res.status).toBe(404);
  });

  it("copies a function parameter's definition, without its source spans", async () => {
    const { add } = await setup();
    const res = await add({
      from: { providerId: "files", promptId: "odin.ts#plan", path: "taskId" },
    });
    const { valueSpan: _v, fullSpan: _f, ...portable } = TASK_ID;
    expect(res).toEqual({
      status: 201,
      body: { id: "1", def: portable, added: true },
    });

    // A structured type, which only a lookup can produce.
    const msgs = await add({
      from: {
        providerId: "files",
        promptId: "odin.ts#plan",
        half: "function",
        path: "threadMsgs",
      },
    });
    expect(msgs.body).toEqual({ id: "2", def: THREAD_MSGS, added: true });
  });

  it("names a copied field after its parameter unless the body names it", async () => {
    const { add } = await setup();
    const res = await add({
      name: "expectedTaskId",
      from: { providerId: "files", promptId: "odin.ts#plan", path: "taskId" },
    });
    expect((res.body as { def: PropDefinition }).def).toMatchObject({
      name: "expectedTaskId",
      type: TASK_ID.type,
    });
  });

  it("copies an execute parameter, by dotted path", async () => {
    const { add } = await setup();
    const res = await add({
      from: {
        providerId: "files",
        promptId: "odin.ts#plan",
        half: "execute",
        path: "toolsContext.db",
      },
    });
    expect(res.body).toEqual({
      id: "1",
      def: {
        name: "db",
        type: { kind: "primitive", syntax: "Db" },
        optional: false,
      },
      added: true,
    });
  });

  it.each([
    [
      "an unknown prompt",
      { providerId: "files", promptId: "nope.ts#x", path: "taskId" },
      /Prompt not found/,
    ],
    [
      "an unknown parameter",
      { providerId: "files", promptId: "odin.ts#plan", path: "nope" },
      /has no function parameter at "nope"/,
    ],
    [
      "a parameter in the other half",
      {
        providerId: "files",
        promptId: "odin.ts#plan",
        half: "execute",
        path: "taskId",
      },
      /has no execute parameter/,
    ],
    [
      "an unknown half",
      {
        providerId: "files",
        promptId: "odin.ts#plan",
        half: "both",
        path: "taskId",
      },
      /from.half must be/,
    ],
    [
      "a missing path",
      { providerId: "files", promptId: "odin.ts#plan" },
      /from must be/,
    ],
    [
      "a check that doesn't exist",
      {
        providerId: "files",
        checkUri: ".evalution/playground/checks.ts#missing",
        path: "title",
      },
      /Check not found/,
    ],
    [
      "a check parameter that doesn't exist",
      {
        providerId: "files",
        checkUri: ".evalution/playground/checks.ts#titled",
        path: "nope",
      },
      /has no parameter "nope"/,
    ],
  ])("rejects a lookup of %s with a 400", async (_label, from, message) => {
    const { add } = await setup();
    const res = await add({ from });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(message);
  });
});

const primitive = (name: string, base: string): PropDefinition => ({
  name,
  type: { kind: "primitive", syntax: base, base: base as "string" },
  optional: true,
});

const value = (v: string | number | boolean | null): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value: v },
});

describe("handleUpdateRows", () => {
  let client: Database | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  /** A dataset of `title: string`, `count: number`, `done: boolean`, `task: Task`, with one row. */
  async function seeded() {
    client = await connect({ path: ":memory:", url: () => null });
    await runDatasetMigrations(drizzle({ client }));
    const provider = new TursoDatasetProvider({ client });
    const dataset = await provider.createDataset({
      name: "Edits",
      fields: [
        { def: primitive("title", "string") },
        { def: primitive("count", "number") },
        { def: primitive("done", "boolean") },
        {
          def: {
            name: "task",
            type: { kind: "opaque", syntax: "Task" },
          } as unknown as PropDefinition,
        },
      ],
    });
    const [row] = await provider.addRows(dataset.id, [
      { cells: { "0": value("old"), "3": value("keep") } },
    ]);
    const update = (cells: Record<string, unknown>, rowId = row.id) =>
      handleUpdateRows(provider, dataset.id, {
        updates: [{ rowId, cells }],
      });
    const cells = async () => (await provider.listRows(dataset.id))[0].cells;
    return { provider, dataset, row, update, cells };
  }

  it("sets primitives of each field's base and clears with null", async () => {
    const { update, cells } = await seeded();
    const res = await update({
      "0": null,
      "1": value(3),
      "2": value(true),
    });
    expect(res.status).toBe(204);
    expect(await cells()).toEqual({
      "1": value(3),
      "2": value(true),
      "3": value("keep"),
    });
  });

  it("accepts a template in a string field", async () => {
    const { update, cells } = await seeded();
    const template: ExecutionInput = {
      kind: "value",
      value: { kind: "template", value: ["Hi ", { expr: "name" }] },
    };
    expect((await update({ "0": template })).status).toBe(204);
    expect((await cells())["0"]).toEqual(template);
  });

  it.each([
    ["a string in a number field", { "1": value("3") }],
    ["a number in a string field", { "0": value(3) }],
    ["a null primitive", { "2": value(null) }],
    [
      "an object value in a string field",
      { "0": { kind: "value", value: { kind: "object", properties: {} } } },
    ],
  ])("rejects %s with a 400, changing nothing", async (_label, cellsIn) => {
    const { update, cells } = await seeded();
    const before = await cells();
    const res = await update(cellsIn);
    expect(res.status).toBe(400);
    expect(await cells()).toEqual(before);
  });

  it("shape-checks any other field's cell, as adding a row does", async () => {
    const { update, cells } = await seeded();
    const object: ExecutionInput = {
      kind: "value",
      value: {
        kind: "object",
        properties: { title: { kind: "primitive", value: "x" } },
      },
    };
    expect((await update({ "3": object })).status).toBe(204);
    expect((await cells())["3"]).toEqual(object);

    expect(
      (await update({ "3": { kind: "value", value: "raw" } })).status,
    ).toBe(400);
  });

  it("sets a resource in any field, as adding a row does", async () => {
    const { update, cells } = await seeded();
    const resource: ExecutionInput = { kind: "instance", name: "task" };
    expect((await update({ "0": resource, "3": resource })).status).toBe(204);
    expect(await cells()).toMatchObject({ "0": resource, "3": resource });
  });

  it("sets and removes a row's resource instances by name, stripping receipts", async () => {
    const { provider, dataset, row } = await seeded();
    const updateResources = (resources: Record<string, unknown>) =>
      handleUpdateRows(provider, dataset.id, {
        updates: [{ rowId: row.id, cells: {}, resources }],
      });
    expect(
      (
        await updateResources({
          db: { uri: "pg.ts#db" },
          task: { uri: "pg.ts#task", receipt: "tsk_1" },
        })
      ).status,
    ).toBe(204);
    expect((await updateResources({ db: null })).status).toBe(204);
    const [stored] = await provider.listRows(dataset.id);
    expect(stored.resources).toEqual({ task: { uri: "pg.ts#task" } });

    expect((await updateResources({ "1bad": { uri: "pg.ts#db" } })).status).toBe(
      400,
    );
    expect((await updateResources({ db: { uri: "" } })).status).toBe(400);
  });

  it("rejects an unknown field or row, and a malformed body", async () => {
    const { provider, dataset, update } = await seeded();
    expect((await update({ z: value("x") })).status).toBe(400);
    expect((await update({ "0": value("x") }, "nope")).status).toBe(400);
    expect(
      (await handleUpdateRows(provider, dataset.id, { rows: [] })).status,
    ).toBe(400);
    expect(
      (
        await handleUpdateRows(provider, dataset.id, {
          updates: [{ cells: {} }],
        })
      ).status,
    ).toBe(400);
  });

  it("responds 404 for an unknown dataset", async () => {
    const { provider } = await seeded();
    const res = await handleUpdateRows(provider, "nope", { updates: [] });
    expect(res.status).toBe(404);
  });
});
