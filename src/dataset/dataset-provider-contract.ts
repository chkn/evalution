// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The {@link DatasetProvider} contract, as a reusable vitest suite. Run by
 * both `turso-dataset-provider.test.ts` and
 * `local-directory-dataset-provider.test.ts` — same behavior, different
 * storage layout. See `specs/datasets.md` §N.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
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
        kind: "instance",
        name: "task",
        output: "taskId",
      };
      const resources = {
        task: {
          uri: ".evalution/playground/tasks.ts#seededTask",
          args: { title: text("Buy milk") },
        },
      };
      const added = await provider.addRows(dataset.id, [
        {
          cells: { "0": text("first"), "1": resource },
          source: { kind: "playground", promptId: "p#x", providerId: "files" },
          resources,
        },
        { cells: { "0": text("second") } },
      ]);

      expect(added).toHaveLength(2);
      for (const row of added) expect(row.id).toMatch(/^[0-9A-Za-z]{10}$/);
      const rows = await provider.listRows(dataset.id);
      expect(rows).toEqual(added);
      expect(rows[0].cells["1"]).toEqual(resource);
      expect(rows[0].resources).toEqual(resources);
      expect(rows[1].resources).toBeUndefined();
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
              kind: "value",
              value: {
                kind: "object",
                properties: {
                  title: { kind: "primitive", value: "Milk" },
                  owner: { kind: "primitive", value: "ann" },
                },
              },
            },
          },
        },
        {
          cells: {
            "1": {
              kind: "object",
              // `title` again, merged by name; `due` is new.
              properties: { due: text("today"), title: text("Eggs") },
            },
            "2": {
              kind: "object",
              properties: {
                db: { kind: "instance", name: "db" },
                userId: text("u1"),
              },
            },
          },
        },
        // A cell naming a resource instance adds no keys.
        {
          cells: {
            "1": { kind: "instance", name: "task", output: "taskId" },
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
          "1": { keys: ["title", "owner", "due"] },
          "2": { keys: ["db", "userId"] },
          "3": { keys: ["title", "note"] },
        },
      });
    });

    it("deletes rows, skipping ids that aren't there", async () => {
      const provider = await makeProvider();
      const dataset = await provider.createDataset({
        name: "Del",
        fields: [{ def: def("a") }],
      });
      const [first, second, third] = await provider.addRows(dataset.id, [
        { cells: { "0": text("1") } },
        { cells: { "0": text("2") } },
        { cells: { "0": text("3") } },
      ]);
      expect(
        await provider.deleteRows(dataset.id, [first.id, "missing", third.id]),
      ).toBe(2);
      expect(await provider.listRows(dataset.id)).toEqual([second]);
      // A no-op for rows that aren't there.
      expect(await provider.deleteRows(dataset.id, [first.id])).toBe(0);
      expect(await provider.deleteRows(dataset.id, [])).toBe(0);
    });

    describe("updateRows", () => {
      /** A dataset of two fields, with two rows. */
      async function seeded(provider: DatasetProvider) {
        const dataset = await provider.createDataset({
          name: "Edits",
          fields: [{ def: def("a") }, { def: def("b", "Task") }],
        });
        const resource: ExecutionInput = {
          kind: "instance",
          name: "task",
          output: "taskId",
        };
        const [first, second] = await provider.addRows(dataset.id, [
          { cells: { "0": text("one"), "1": resource } },
          { cells: { "0": text("two") } },
        ]);
        return { dataset, first, second, resource };
      }

      it("sets cells, leaving other cells and rows untouched", async () => {
        const provider = await makeProvider();
        const { dataset, first, second, resource } = await seeded(provider);
        await provider.updateRows(dataset.id, [
          { rowId: first.id, cells: { "0": text("uno") } },
        ]);
        const rows = await provider.listRows(dataset.id);
        expect(rows[0]).toEqual({
          ...first,
          cells: { "0": text("uno"), "1": resource },
        });
        expect(rows[1]).toEqual(second);
      });

      it("replaces a cell whole, rather than merging into it", async () => {
        const provider = await makeProvider();
        const { dataset, first } = await seeded(provider);
        // A `null` inside a value is data, not a deletion.
        const replacement: ExecutionInput = {
          kind: "value",
          value: {
            kind: "object",
            properties: { title: { kind: "primitive", value: null } },
          },
        };
        await provider.updateRows(dataset.id, [
          { rowId: first.id, cells: { "1": replacement } },
        ]);
        const [row] = await provider.listRows(dataset.id);
        expect(row.cells["1"]).toEqual(replacement);
      });

      it("sets and removes resource instances by name, leaving the rest", async () => {
        const provider = await makeProvider();
        const { dataset, first, second } = await seeded(provider);
        const root = { uri: "pg.ts#seededTask", args: { title: text("Root") } };
        const child = {
          uri: "pg.ts#seededTask",
          args: {
            title: text("Child"),
            parentId: {
              kind: "instance",
              name: "root",
              output: "taskId",
            } satisfies ExecutionInput,
          },
        };
        await provider.updateRows(dataset.id, [
          { rowId: first.id, cells: {}, resources: { root, child } },
        ]);
        expect((await provider.listRows(dataset.id))[0].resources).toEqual({
          root,
          child,
        });

        await provider.updateRows(dataset.id, [
          { rowId: first.id, cells: {}, resources: { child: null } },
        ]);
        const rows = await provider.listRows(dataset.id);
        expect(rows[0].resources).toEqual({ root });
        expect(rows[0].cells).toEqual(first.cells);
        expect(rows[1]).toEqual(second);
      });

      it("fills an empty cell, and clears one by removing its key", async () => {
        const provider = await makeProvider();
        const { dataset, first, second } = await seeded(provider);
        await provider.updateRows(dataset.id, [
          { rowId: first.id, cells: { "0": null, "1": null } },
          { rowId: second.id, cells: { "1": text("filled") } },
        ]);
        const rows = await provider.listRows(dataset.id);
        expect(rows[0].cells).toEqual({});
        expect(Object.keys(rows[0].cells)).toEqual([]);
        expect(rows[1].cells).toEqual({
          "0": text("two"),
          "1": text("filled"),
        });
      });

      it.each([
        [
          "a resource cell",
          { kind: "instance", name: "db" } satisfies ExecutionInput,
        ],
        [
          "an object cell",
          { kind: "object", properties: {} } satisfies ExecutionInput,
        ],
      ])("sets %s, as addRows takes", async (_label, cell) => {
        const provider = await makeProvider();
        const { dataset, first, second } = await seeded(provider);
        await provider.updateRows(dataset.id, [
          { rowId: second.id, cells: { "1": cell } },
          { rowId: first.id, cells: { "0": cell } },
        ]);
        const rows = await provider.listRows(dataset.id);
        expect(rows[0].cells["0"]).toEqual(cell);
        expect(rows[1].cells["1"]).toEqual(cell);
      });

      it("rejects an unknown field or row, changing nothing", async () => {
        const provider = await makeProvider();
        const { dataset, first } = await seeded(provider);
        const before = await provider.listRows(dataset.id);
        await expect(
          provider.updateRows(dataset.id, [
            { rowId: first.id, cells: { "0": text("changed") } },
            { rowId: first.id, cells: { z: text("unknown") } },
          ]),
        ).rejects.toBeInstanceOf(DatasetValidationError);
        await expect(
          provider.updateRows(dataset.id, [
            { rowId: first.id, cells: { "0": text("changed") } },
            { rowId: "nope", cells: { "0": text("unknown") } },
          ]),
        ).rejects.toBeInstanceOf(DatasetValidationError);
        expect(await provider.listRows(dataset.id)).toEqual(before);
      });

      it("rejects updates to a dataset that doesn't exist", async () => {
        const provider = await makeProvider();
        await expect(provider.updateRows("missing", [])).rejects.toThrow(
          /not found/,
        );
      });

      it("emits an update", async () => {
        const provider = await makeProvider();
        const { dataset, first } = await seeded(provider);
        const events: DatasetChangeEvent[] = [];
        provider.watch?.(e => events.push(e));
        await provider.updateRows(dataset.id, [
          { rowId: first.id, cells: { "0": text("uno") } },
        ]);
        if (provider.watch) {
          expect(events).toEqual([{ type: "update", datasetId: dataset.id }]);
        }
      });

      it("leaves a batch that changes no cells unrecorded: no updatedAt bump, no event", async () => {
        const provider = await makeProvider();
        const { dataset, first } = await seeded(provider);
        const before = await provider.getDataset(dataset.id);
        const events: DatasetChangeEvent[] = [];
        provider.watch?.(e => events.push(e));
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime((before?.updatedAt ?? 0) + 60_000);
          await provider.updateRows(dataset.id, []);
          await provider.updateRows(dataset.id, [
            { rowId: first.id, cells: {} },
          ]);
          expect((await provider.getDataset(dataset.id))?.updatedAt).toBe(
            before?.updatedAt,
          );
          expect(events).toEqual([]);

          // One cell is enough to count.
          await provider.updateRows(dataset.id, [
            { rowId: first.id, cells: {} },
            { rowId: first.id, cells: { "0": text("uno") } },
          ]);
          expect((await provider.getDataset(dataset.id))?.updatedAt).toBe(
            (before?.updatedAt ?? 0) + 60_000,
          );
          if (provider.watch) {
            expect(events).toEqual([{ type: "update", datasetId: dataset.id }]);
          }
        } finally {
          vi.useRealTimers();
        }
      });
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

      // Marked as added by hand, unlike the fields it was created with.
      expect(c).toEqual({ id: "2", def: def("c"), added: true });
      expect(d).toEqual({ id: "3", def: def("d", "number"), added: true });
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

    describe("renameField", () => {
      it("renames a field, keeping its id and every row's cells", async () => {
        const provider = await makeProvider();
        if (!provider.renameField) return;
        const dataset = await provider.createDataset({
          name: "Rename",
          fields: [{ def: def("a") }, { def: def("b") }],
        });
        const rows = await provider.addRows(dataset.id, [
          { cells: { "0": text("x"), "1": text("y") } },
        ]);
        const renamed = await provider.renameField(dataset.id, "0", "alpha");
        expect(renamed).toEqual({ id: "0", def: def("alpha") });
        expect((await provider.getDataset(dataset.id))?.fields).toEqual([
          { id: "0", def: def("alpha") },
          { id: "1", def: def("b") },
        ]);
        expect(await provider.listRows(dataset.id)).toEqual(rows);
      });

      it("rejects a name that clashes with another field of the same type, or an unknown field", async () => {
        const provider = await makeProvider();
        if (!provider.renameField) return;
        const dataset = await provider.createDataset({
          name: "Clash",
          fields: [
            { def: def("a") },
            { def: def("b") },
            { def: def("c", "number") },
          ],
        });
        await expect(
          provider.renameField(dataset.id, "1", "a"),
        ).rejects.toThrow("`a: string` already exists");
        // A different type isn't a clash.
        await provider.renameField(dataset.id, "2", "a");
        // Renaming a field to its own name isn't either.
        await provider.renameField(dataset.id, "0", "a");
        await expect(
          provider.renameField(dataset.id, "z", "x"),
        ).rejects.toBeInstanceOf(DatasetValidationError);
        await expect(
          provider.renameField("missing", "0", "x"),
        ).rejects.toBeInstanceOf(DatasetNotFoundError);
      });
    });

    describe("deleteField", () => {
      it("removes the field and its cells, and never reuses its id", async () => {
        const provider = await makeProvider();
        if (!provider.deleteField) return;
        const dataset = await provider.createDataset({
          name: "Drop",
          fields: [{ def: def("a") }, { def: def("b") }],
        });
        const [row] = await provider.addRows(dataset.id, [
          { cells: { "0": text("x"), "1": text("y") } },
        ]);
        await provider.deleteField(dataset.id, "0");
        expect((await provider.getDataset(dataset.id))?.fields).toEqual([
          { id: "1", def: def("b") },
        ]);
        expect(await provider.listRows(dataset.id)).toEqual([
          { ...row, cells: { "1": text("y") } },
        ]);
        const next = await provider.addField(dataset.id, def("a"));
        expect(next.id).toBe("2");
      });

      it("rejects an unknown field", async () => {
        const provider = await makeProvider();
        if (!provider.deleteField) return;
        const dataset = await provider.createDataset({
          name: "Unknown",
          fields: [{ def: def("a") }],
        });
        await expect(
          provider.deleteField(dataset.id, "9"),
        ).rejects.toBeInstanceOf(DatasetValidationError);
        await expect(
          provider.deleteField("missing", "0"),
        ).rejects.toBeInstanceOf(DatasetNotFoundError);
      });
    });

    describe("queryRows", () => {
      const number = (value: number): ExecutionInput => ({
        kind: "value",
        value: { kind: "primitive", value },
      });

      it("queries a view with a column per field, named after it", async () => {
        const provider = await makeProvider();
        if (!provider.queryRows) return;
        const dataset = await provider.createDataset({
          name: "Query",
          fields: [{ def: def("city") }, { def: def("pop", "number") }],
        });
        // Another dataset's rows stay out of the view.
        const other = await provider.createDataset({
          name: "Other",
          fields: [{ def: def("city") }],
        });
        await provider.addRows(other.id, [{ cells: { "0": text("Nowhere") } }]);
        const rows = await provider.addRows(dataset.id, [
          { cells: { "0": text("Oslo"), "1": number(700) } },
          { cells: { "0": text("Bergen"), "1": number(290) } },
          { cells: { "0": text("Tromsø") } },
        ]);

        const result = await provider.queryRows(
          dataset.id,
          "SELECT _id, city, pop FROM rows WHERE pop > 100 ORDER BY pop",
        );
        expect(result).toEqual({
          columns: ["_id", "city", "pop"],
          rows: [
            { _id: rows[1].id, city: "Bergen", pop: 290 },
            { _id: rows[0].id, city: "Oslo", pop: 700 },
          ],
        });
      });

      it("joins a query's own WITH clause, shows non-primitive cells as JSON, and truncates", async () => {
        const provider = await makeProvider();
        if (!provider.queryRows) return;
        const dataset = await provider.createDataset({
          name: "Shapes",
          fields: [{ def: def("data", "object") }],
        });
        const objectCell: ExecutionInput = {
          kind: "value",
          value: {
            kind: "object",
            properties: { a: { kind: "primitive", value: 1 } },
          },
        };
        await provider.addRows(dataset.id, [
          { cells: { "0": objectCell } },
          { cells: { "0": { kind: "instance", name: "db" } } },
        ]);
        const result = await provider.queryRows(
          dataset.id,
          "WITH d AS (SELECT data FROM rows) SELECT data FROM d",
          { maxRows: 1 },
        );
        expect(result.truncated).toBe(true);
        expect(result.rows).toHaveLength(1);
        expect(JSON.parse(result.rows[0].data as string)).toEqual(
          objectCell.kind === "value" && objectCell.value,
        );
        const all = await provider.queryRows(
          dataset.id,
          "SELECT data FROM rows",
        );
        expect(JSON.parse(all.rows[1].data as string)).toEqual({
          kind: "instance",
          name: "db",
        });
      });

      it("refuses writes and reports bad SQL", async () => {
        const provider = await makeProvider();
        if (!provider.queryRows) return;
        const dataset = await provider.createDataset({
          name: "Safe",
          fields: [{ def: def("a") }],
        });
        await provider.addRows(dataset.id, [{ cells: { "0": text("x") } }]);
        await expect(
          provider.queryRows(dataset.id, "DELETE FROM dataset_rows"),
        ).rejects.toThrow();
        await expect(
          provider.queryRows(dataset.id, "SELECT nope FROM rows"),
        ).rejects.toThrow();
        expect(await provider.listRows(dataset.id)).toHaveLength(1);
        // Writes still work afterwards: read-only mode was switched back off.
        await provider.addRows(dataset.id, [{ cells: {} }]);
        expect(await provider.listRows(dataset.id)).toHaveLength(2);
        await expect(
          provider.queryRows("missing", "SELECT 1"),
        ).rejects.toBeInstanceOf(DatasetNotFoundError);
      });
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
