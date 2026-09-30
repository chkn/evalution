// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { runDatasetMigrations } from "../../dataset/db/migrate.ts";
import { TursoDatasetProvider } from "../../dataset/turso-dataset-provider.ts";
import type { ExecutionInput, PropDefinition } from "../../shared/types.ts";
import { handleUpdateRows } from "./datasets.ts";

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
    ["a resource in a string field", { "0": { kind: "resource", uri: "a#b" } }],
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
    // Well-formed, but not a value: only the provider knows to refuse it.
    expect(
      (await update({ "3": { kind: "resource", uri: "pg.ts#task" } })).status,
    ).toBe(400);
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
