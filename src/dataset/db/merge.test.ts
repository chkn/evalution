// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { copyRows } from "../../sync/local-database.ts";
import { def, text } from "../dataset-provider-contract.ts";
import type { DatasetField } from "../dataset-types.ts";
import { TursoDatasetProvider } from "../turso-dataset-provider.ts";
import { mergeDatasetTables, unionFields } from "./merge.ts";
import { runDatasetMigrations } from "./migrate.ts";

const field = (id: string, name: string): DatasetField => ({
  id,
  def: def(name),
});

describe("unionFields", () => {
  it("keeps the cloud's fields, joins local ones to the field of the same name, and adds the rest", () => {
    const { fields, nextFieldId, ids } = unionFields(
      [field("0", "question"), field("1", "answer")],
      2,
      [field("0", "answer"), field("1", "notes")],
    );

    expect(fields).toEqual([
      field("0", "question"),
      field("1", "answer"),
      field("2", "notes"),
    ]);
    expect(nextFieldId).toBe(3);
    expect(ids).toEqual(
      new Map([
        ["0", "1"],
        ["1", "2"],
      ]),
    );
  });

  it("never mints an id the cloud's dataset has used", () => {
    // Field 2 was deleted from the cloud's copy; its id isn't minted again.
    const { fields } = unionFields([field("0", "question")], 3, [
      field("0", "notes"),
    ]);

    expect(fields.map(f => f.id)).toEqual(["0", "3"]);
  });
});

describe("mergeDatasetTables", () => {
  const clients: Database[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(c => c.close()));
  });

  async function datasetDb(
    name: string,
    fields: string[],
    rows: Record<string, string>[],
  ) {
    const client = await connect({ path: ":memory:" });
    clients.push(client);
    await runDatasetMigrations(drizzle({ client }));
    const provider = new TursoDatasetProvider({ client });
    const dataset = await provider.createDataset(
      { name, fields: fields.map(f => ({ def: def(f) })) },
      { id: "tickets" },
    );
    await provider.addRows(
      dataset.id,
      rows.map(cells => ({
        cells: Object.fromEntries(
          Object.entries(cells).map(([id, value]) => [id, text(value)]),
        ),
      })),
    );
    return { client, provider };
  }

  /** A row's cells, as the text `text()` made them from. */
  const values = (row: { cells: Record<string, unknown> }) =>
    Object.fromEntries(
      Object.entries(row.cells).map(([id, cell]) => [
        id,
        (cell as { value: { value: string } }).value.value,
      ]),
    );

  it("adds the local fields to the cloud's dataset, and moves the local rows' cells to them", async () => {
    const cloud = await datasetDb(
      "Tickets",
      ["question", "answer"],
      [{ "0": "q1", "1": "a1" }],
    );
    const local = await datasetDb(
      "My tickets",
      ["answer", "notes"],
      [{ "0": "a2", "1": "n2" }],
    );

    await copyRows(local.client, cloud.client, mergeDatasetTables);

    const merged = await cloud.provider.getDataset("tickets");
    expect(merged?.name).toBe("Tickets");
    expect(merged?.fields.map(f => [f.id, f.def.name])).toEqual([
      ["0", "question"],
      ["1", "answer"],
      ["2", "notes"],
    ]);
    const rows = (await cloud.provider.listRows("tickets")).map(values);
    expect(rows).toEqual(
      expect.arrayContaining([
        { "0": "q1", "1": "a1" },
        { "1": "a2", "2": "n2" },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("drops the cells of fields deleted locally", async () => {
    const cloud = await datasetDb("Tickets", ["question", "answer"], []);
    const local = await datasetDb(
      "Tickets",
      ["question", "scratch"],
      [{ "0": "q", "1": "gone" }],
    );
    await local.provider.deleteField("tickets", "1");

    await copyRows(local.client, cloud.client, mergeDatasetTables);

    expect((await cloud.provider.listRows("tickets")).map(values)).toEqual([
      { "0": "q" },
    ]);
  });

  it("copies the local dataset as it is when the cloud's copy has none", async () => {
    const cloud = await connect({ path: ":memory:" });
    clients.push(cloud);
    await runDatasetMigrations(drizzle({ client: cloud }));
    const local = await datasetDb("Tickets", ["question"], [{ "0": "q" }]);

    await copyRows(local.client, cloud, mergeDatasetTables);

    const provider = new TursoDatasetProvider({ client: cloud });
    expect((await provider.getDataset("tickets"))?.name).toBe("Tickets");
    expect((await provider.listRows("tickets")).map(values)).toEqual([
      { "0": "q" },
    ]);
  });
});
