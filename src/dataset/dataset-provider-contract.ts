// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The {@link DatasetProvider} contract, as a reusable vitest suite. Run by
 * both `turso-dataset-provider.test.ts` and
 * `local-directory-dataset-provider.test.ts` — same behavior, different
 * storage layout. See `specs/datasets.md` §N.
 */

import { afterAll, describe, expect, it } from "vitest";
import type { ExecutionInput, PropDefinition } from "../shared/types.ts";
import {
  DatasetNotFoundError,
  type DatasetProvider,
  DatasetValidationError,
} from "./dataset-provider.ts";
import type { DatasetChangeEvent } from "./dataset-types.ts";

/** A `PropDefinition` for a field, with a primitive type of `syntax`. */
export function def(name: string, syntax = "string"): PropDefinition {
  return {
    name,
    type: { kind: "primitive", syntax },
  } as PropDefinition;
}

/** A typed-in string cell. */
export function text(value: string): ExecutionInput {
  return { kind: "value", value: { kind: "primitive", value } };
}

/**
 * Runs the dataset provider contract under `describe(name, …)`.
 * `makeProvider` mints a fresh, independent provider on every call;
 * `cleanup` runs once after the suite.
 */
export function runDatasetProviderContractTests(
  name: string,
  makeProvider: () => Promise<DatasetProvider>,
  cleanup?: () => Promise<void>,
): void {
  describe(`${name} (DatasetProvider contract)`, () => {
    if (cleanup) afterAll(cleanup);

    it("starts empty", async () => {
      const provider = await makeProvider();
      expect(await provider.listDatasets()).toEqual([]);
      expect(await provider.getDataset("nope")).toBeUndefined();
      expect(await provider.listRows("nope")).toEqual([]);
    });

    it("creates a dataset with a slug id and minted field ids", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Support tickets",
        fields: [{ def: def("ticket") }, { def: def("verbose", "boolean") }],
        prompt: { id: "tickets#classify", providerId: "files" },
      });

      expect(dataset.id).toBe("support-tickets");
      expect(dataset.name).toBe("Support tickets");
      expect(dataset.fields).toEqual([
        { id: "0", def: def("ticket") },
        { id: "1", def: def("verbose", "boolean") },
      ]);
      expect(dataset.prompt).toEqual({
        id: "tickets#classify",
        providerId: "files",
      });
      expect(await provider.getDataset(dataset.id)).toEqual(dataset);
    });

    it("mints base-36 field ids", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Wide",
        fields: Array.from({ length: 12 }, (_, i) => ({ def: def(`f${i}`) })),
      });
      expect(dataset.fields.map(f => f.id)).toEqual([
        ..."0123456789ab".split(""),
      ]);
    });

    it("gives a colliding name a suffixed id", async () => {
      const provider = await makeProvider();
      const a = await provider.createDataset({ name: "Tickets", fields: [] });
      const b = await provider.createDataset({ name: "Tickets", fields: [] });
      expect([a.id, b.id]).toEqual(["tickets", "tickets-2"]);
    });

    it("lists summaries with row counts, most recently updated first", async () => {
      const provider = await makeProvider();
      const a = await provider.createDataset({
        name: "A",
        fields: [{ def: def("x") }],
      });
      const b = await provider.createDataset({ name: "B", fields: [] });
      await new Promise(r => setTimeout(r, 5));
      await provider.addRows(a.id, [
        { cells: { "0": text("one") } },
        { cells: { "0": text("two") } },
      ]);

      const list = await provider.listDatasets();
      expect(list.map(s => [s.id, s.rowCount])).toEqual([
        [a.id, 2],
        [b.id, 0],
      ]);
      expect(list[0].providerId).toBe(provider.id);
    });

    it("adds rows in order, minting short ids, and reads cells back equal", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Rows",
        fields: [{ def: def("ticket") }, { def: def("db", "Db") }],
      });
      const resource: ExecutionInput = {
        kind: "resource",
        uri: ".evalution/playground/tasks.ts#seededTask",
        args: { title: text("Buy milk") },
      };
      const added = await provider.addRows(dataset.id, [
        {
          cells: { "0": text("first"), "1": resource },
          source: { kind: "playground", promptId: "p#x", providerId: "files" },
        },
        { cells: { "0": text("second") } },
      ]);

      expect(added).toHaveLength(2);
      for (const row of added) expect(row.id).toMatch(/^[0-9A-Za-z]{10}$/);
      const rows = await provider.listRows(dataset.id);
      expect(rows).toEqual(added);
      expect(rows[0].cells["1"]).toEqual(resource);
      expect(rows[0].source).toEqual({
        kind: "playground",
        promptId: "p#x",
        providerId: "files",
      });
      expect(rows[1].source).toBeUndefined();
    });

    it("doesn't store absent cells", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Sparse",
        fields: [{ def: def("a") }, { def: def("b") }],
      });
      await provider.addRows(dataset.id, [
        { cells: { "0": text("only a"), "1": undefined as any } },
      ]);
      const [row] = await provider.listRows(dataset.id);
      expect(Object.keys(row.cells)).toEqual(["0"]);
    });

    it("rejects cells with unknown field ids, adding nothing", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Strict",
        fields: [{ def: def("a") }],
      });
      await expect(
        provider.addRows(dataset.id, [
          { cells: { "0": text("fine") } },
          { cells: { z: text("unknown") } },
        ]),
      ).rejects.toBeInstanceOf(DatasetValidationError);
      expect(await provider.listRows(dataset.id)).toEqual([]);
    });

    it("rejects rows for a dataset that doesn't exist", async () => {
      const provider = await makeProvider();
      await expect(
        provider.addRows("missing", [{ cells: {} }]),
      ).rejects.toThrow(/not found/);
    });

    it("renames without changing the id", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Tickets",
        fields: [],
      });
      const renamed = await provider.renameDataset(dataset.id, "Refunds");
      expect(renamed.id).toBe(dataset.id);
      expect(renamed.name).toBe("Refunds");
      expect((await provider.getDataset(dataset.id))?.name).toBe("Refunds");
    });

    it("pages rows by offset and limit, in insertion order", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Paged",
        fields: [{ def: def("n") }],
      });
      const added = await provider.addRows(
        dataset.id,
        ["0", "1", "2", "3", "4"].map(n => ({ cells: { "0": text(n) } })),
      );

      expect(
        await provider.listRows(dataset.id, { offset: 1, limit: 2 }),
      ).toEqual(added.slice(1, 3));
      expect(await provider.listRows(dataset.id, { offset: 3 })).toEqual(
        added.slice(3),
      );
      expect(await provider.listRows(dataset.id, { limit: 2 })).toEqual(
        added.slice(0, 2),
      );
      expect(await provider.listRows(dataset.id, { offset: 9 })).toEqual([]);
    });

    it("describes rows: their count and the keys inside their cells", async () => {
      const provider = await makeProvider();
      expect(await provider.describeRows("nope")).toEqual({
        rowCount: 0,
        fields: {},
      });
      const dataset = await provider.createDataset({
        name: "Shapes",
        fields: [
          { def: def("ticket") },
          { def: def("task", "Task") },
          { def: def("ctx", "Ctx") },
          { def: def("info", "Info") },
        ],
      });
      await provider.addRows(dataset.id, [
        {
          cells: {
            "0": text("a"),
            "1": {
              kind: "resource",
              uri: "pg.ts#seededTask",
              args: { title: text("Milk"), owner: text("ann") },
            },
          },
        },
        {
          cells: {
            "1": {
              kind: "resource",
              uri: "pg.ts#otherTask",
              // `title` again, merged by name; `due` is new.
              args: { due: text("today"), title: text("Eggs") },
            },
            "2": {
              kind: "object",
              properties: {
                db: { kind: "resource", uri: "pg.ts#db" },
                userId: text("u1"),
              },
            },
          },
        },
        // A resource without arguments adds no keys, but still marks the
        // field as one a resource fills.
        {
          cells: {
            "1": { kind: "resource", uri: "pg.ts#blank" },
            // A typed-in object's properties are keys too.
            "3": {
              kind: "value",
              value: {
                kind: "object",
                properties: {
                  title: { kind: "primitive", value: "Hi" },
                  note: { kind: "primitive", value: "there" },
                },
              },
            },
          },
        },
      ]);

      expect(await provider.describeRows(dataset.id)).toEqual({
        rowCount: 3,
        fields: {
          "1": { keys: ["title", "owner", "due"], resource: true },
          "2": { keys: ["db", "userId"] },
          "3": { keys: ["title", "note"] },
        },
      });
    });

    it("deletes one row", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Del",
        fields: [{ def: def("a") }],
      });
      const [first, second] = await provider.addRows(dataset.id, [
        { cells: { "0": text("1") } },
        { cells: { "0": text("2") } },
      ]);
      await provider.deleteRow(dataset.id, first.id);
      expect(await provider.listRows(dataset.id)).toEqual([second]);
      // A no-op for a row that isn't there.
      await provider.deleteRow(dataset.id, first.id);
    });

    it("deletes a dataset along with its rows", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Gone",
        fields: [{ def: def("a") }],
      });
      await provider.addRows(dataset.id, [{ cells: { "0": text("x") } }]);
      await provider.deleteDataset(dataset.id);

      expect(await provider.getDataset(dataset.id)).toBeUndefined();
      expect(await provider.listRows(dataset.id)).toEqual([]);
      expect(await provider.listDatasets()).toEqual([]);
      // Recreating under the same name starts fresh, not with stale rows.
      const again = await provider.createDataset({
        name: "Gone",
        fields: [{ def: def("a") }],
      });
      expect(await provider.listRows(again.id)).toEqual([]);
    });

    it("adds a field, minting an id after the existing ones", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Grow",
        fields: [{ def: def("a") }, { def: def("b") }],
      });
      const c = await provider.addField(dataset.id, def("c"));
      const d = await provider.addField(dataset.id, def("d", "number"));

      expect(c).toEqual({ id: "2", def: def("c") });
      expect(d).toEqual({ id: "3", def: def("d", "number") });
      expect((await provider.getDataset(dataset.id))?.fields).toEqual([
        { id: "0", def: def("a") },
        { id: "1", def: def("b") },
        c,
        d,
      ]);
      const [summary] = await provider.listDatasets();
      expect(summary.fields.map(f => f.id)).toEqual(["0", "1", "2", "3"]);
    });

    it("keeps minted field ids unique on a dataset created without fields", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Blank",
        fields: [],
      });
      const ids = [];
      for (let i = 0; i < 12; i++) {
        ids.push((await provider.addField(dataset.id, def(`f${i}`))).id);
      }
      expect(ids).toEqual([..."0123456789ab".split("")]);
    });

    it("rejects a field with the same name and type as an existing one", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Dup",
        fields: [{ def: def("title") }],
      });
      await expect(provider.addField(dataset.id, def("title"))).rejects.toThrow(
        "`title: string` already exists",
      );
      await expect(
        provider.addField(dataset.id, def("title")),
      ).rejects.toBeInstanceOf(DatasetValidationError);
      // The same name with a different type is a different field.
      const other = await provider.addField(dataset.id, def("title", "number"));
      expect(other.id).toBe("1");
      expect((await provider.getDataset(dataset.id))?.fields).toHaveLength(2);
    });

    it("leaves rows untouched when adding a field", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Rows stay",
        fields: [{ def: def("a") }],
      });
      const added = await provider.addRows(dataset.id, [
        { cells: { "0": text("x") } },
        { cells: {} },
      ]);
      const field = await provider.addField(dataset.id, def("b"));
      expect(await provider.listRows(dataset.id)).toEqual(added);
      // The new column can be filled like any other.
      const [row] = await provider.addRows(dataset.id, [
        { cells: { [field.id]: text("y") } },
      ]);
      expect(row.cells).toEqual({ [field.id]: text("y") });
    });

    it("rejects a field for a dataset that doesn't exist", async () => {
      const provider = await makeProvider();
      await expect(
        provider.addField("missing", def("a")),
      ).rejects.toBeInstanceOf(DatasetNotFoundError);
    });

    it("emits change events", async () => {
      const provider = await makeProvider();
      const events: DatasetChangeEvent[] = [];
      provider.watch?.(e => events.push(e));
      const dataset = await provider.createDataset({ name: "W", fields: [] });
      await provider.addRows(dataset.id, [{ cells: {} }]);
      await provider.renameDataset(dataset.id, "W2");
      await provider.addField(dataset.id, def("a"));
      await provider.deleteDataset(dataset.id);
      expect(events).toEqual([
        { type: "add", datasetId: "w" },
        { type: "update", datasetId: "w" },
        { type: "update", datasetId: "w" },
        { type: "update", datasetId: "w" },
        { type: "remove", datasetId: "w" },
      ]);
    });
  });
}
