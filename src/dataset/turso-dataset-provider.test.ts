// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import {
  def,
  runDatasetProviderContractTests,
  text,
} from "./dataset-provider-contract.ts";
import { runDatasetMigrations } from "./db/migrate.ts";
import { TursoDatasetProvider } from "./turso-dataset-provider.ts";

const clients: Database[] = [];

/** An in-memory client with the dataset schema applied. */
async function makeMigratedClient(): Promise<Database> {
  const client = await connect({ path: ":memory:", url: () => null });
  clients.push(client);
  await runDatasetMigrations(drizzle({ client }));
  return client;
}

async function query(client: Database, sql: string): Promise<any[]> {
  const stmt = await client.prepare(sql);
  return stmt.all();
}

runDatasetProviderContractTests(
  "TursoDatasetProvider",
  async () => new TursoDatasetProvider({ client: await makeMigratedClient() }),
  async () => {
    await Promise.all(clients.splice(0).map(c => c.close()));
  },
);

describe("TursoDatasetProvider storage", () => {
  let client: Database;

  afterEach(async () => {
    await client?.close();
  });

  it("stores cells and source as JSONB blobs", async () => {
    client = await makeMigratedClient();
    const provider = new TursoDatasetProvider({ client });
    const dataset = await provider.createDataset({
      name: "Blobs",
      fields: [{ def: def("a") }],
    });
    await provider.addRows(dataset.id, [
      {
        cells: { "0": text("x") },
        source: { kind: "trace", traceId: "t1", traceProviderId: "local-db" },
      },
    ]);

    const [row] = await query(
      client,
      "SELECT typeof(cells) AS cells, typeof(source) AS source, json_extract(cells, '$.0.kind') AS kind FROM dataset_rows",
    );
    expect(row).toMatchObject({ cells: "blob", source: "blob", kind: "value" });
  });

  it("records the field counter so ids are never reused", async () => {
    client = await makeMigratedClient();
    const provider = new TursoDatasetProvider({ client });
    await provider.createDataset({
      name: "Counter",
      fields: [{ def: def("a") }, { def: def("b") }, { def: def("c") }],
    });
    const [row] = await query(client, "SELECT next_field_id FROM datasets");
    expect(row.next_field_id).toBe(3);
  });

  it("holds several datasets in one database, keyed by dataset_id", async () => {
    client = await makeMigratedClient();
    const provider = new TursoDatasetProvider({ client });
    const a = await provider.createDataset({
      name: "A",
      fields: [{ def: def("x") }],
    });
    const b = await provider.createDataset({
      name: "B",
      fields: [{ def: def("x") }],
    });
    await provider.addRows(a.id, [{ cells: { "0": text("in a") } }]);

    expect(await provider.listRows(a.id)).toHaveLength(1);
    expect(await provider.listRows(b.id)).toEqual([]);
  });
});
