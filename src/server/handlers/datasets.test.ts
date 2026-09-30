// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { runDatasetMigrations } from "../../dataset/db/migrate.ts";
import { TursoDatasetProvider } from "../../dataset/turso-dataset-provider.ts";
import type { PropDefinition } from "../../shared/types.ts";
import {
  type FieldSourcePrompt,
  handleAddField,
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
      handleAddField(provider, datasetId, body, lookup);
    return { provider, dataset, add };
  }

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
    expect(res).toEqual({ status: 201, body: { id: "1", def: portable } });

    // A structured type, which only a lookup can produce.
    const msgs = await add({
      from: {
        providerId: "files",
        promptId: "odin.ts#plan",
        half: "function",
        path: "threadMsgs",
      },
    });
    expect(msgs.body).toEqual({ id: "2", def: THREAD_MSGS });
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
      "a check's parameter",
      { checkUri: ".evalution/playground/checks.ts#titled", path: "title" },
      /check's parameter isn't supported yet/,
    ],
  ])("rejects a lookup of %s with a 400", async (_label, from, message) => {
    const { add } = await setup();
    const res = await add({ from });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(message);
  });
});
