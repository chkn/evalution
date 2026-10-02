// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * {@link DatasetProvider} backed by a Turso/libSQL database. Holds any number
 * of datasets, keyed by `dataset_id` — the class a cloud project DB uses
 * as-is. {@link LocalDirectoryDatasetProvider} composes one of these per file
 * for the local one-file-per-dataset layout. See `specs/datasets.md` §E.
 */

import type { Database } from "@tursodatabase/sync";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { matchKey } from "../shared/dataset-fields.ts";
import type { ExecutionInput, PropDefinition } from "../shared/types.ts";
import {
  type ReadOnlyQueryRunner,
  runReadOnlyQuery,
  type SqlQueryOptions,
  type SqlQueryResult,
} from "../trace/db/read-only-query.ts";
import type { PromptID } from "../trace/trace-types.ts";
import {
  fieldIdFor,
  mintRowId,
  slugifyDatasetName,
  uniqueDatasetId,
} from "./dataset-ids.ts";
import {
  type CreateDatasetInput,
  DatasetNotFoundError,
  type DatasetProvider,
  DatasetValidationError,
  type ListRowsOptions,
  type NewDatasetRow,
} from "./dataset-provider.ts";
import { datasetRowsQuery } from "./dataset-query.ts";
import type {
  Dataset,
  DatasetChangeEvent,
  DatasetField,
  DatasetFieldShape,
  DatasetRow,
  DatasetRowSource,
  DatasetRowsOverview,
  DatasetRowUpdate,
  DatasetSummary,
} from "./dataset-types.ts";
import { datasetRows, datasets, jsonColumn } from "./db/schema.ts";

function parseJson<T>(v: string | null): T | undefined {
  return v == null ? undefined : (JSON.parse(v) as T);
}

function rowToDataset(row: typeof datasets.$inferSelect): Dataset {
  return {
    id: row.id,
    name: row.name,
    fields: JSON.parse(row.fields) as DatasetField[],
    ...(row.prompt && { prompt: parseJson<PromptID>(row.prompt) }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The `cells` column after one row's update, computed in SQLite so only the
 * touched keys of the JSONB blob change: `jsonb_set` for each cell set,
 * `jsonb_remove` for each cleared. `undefined` when there's nothing to do.
 *
 * Not `json_patch`: Turso's rejects a JSONB argument, and a merge patch would
 * also merge a new cell into the keys of the one it replaces, and drop any
 * `null` inside the new value. Setting and removing whole keys has neither
 * problem. Field ids are base-36 (checked by the caller), so they need no
 * escaping inside a quoted path.
 */
function mergedCells(
  cells: Record<string, ExecutionInput | null>,
): SQL | undefined {
  const entries = Object.entries(cells);
  if (entries.length === 0) return undefined;
  const set = entries.filter(([, cell]) => cell !== null);
  const cleared = entries.filter(([, cell]) => cell === null);
  const path = (fieldId: string) => `$."${fieldId}"`;
  let expr: SQL = sql`${datasetRows.cells}`;
  if (set.length > 0) {
    expr = sql`jsonb_set(${expr}, ${sql.join(
      set.map(
        ([fieldId, cell]) =>
          sql`${path(fieldId)}, jsonb(${JSON.stringify(cell)})`,
      ),
      sql`, `,
    )})`;
  }
  if (cleared.length > 0) {
    expr = sql`jsonb_remove(${expr}, ${sql.join(
      cleared.map(([fieldId]) => sql`${path(fieldId)}`),
      sql`, `,
    )})`;
  }
  return expr;
}

/** Options for {@link TursoDatasetProvider.createDataset} beyond the interface's. */
export interface TursoCreateDatasetOptions {
  /**
   * The id to create the dataset under. Defaults to a slug of its name, made
   * unique within this database.
   */
  id?: string;
}

/**
 * `DatasetProvider` backed by a Turso/libSQL database via
 * `drizzle-orm/tursodatabase-sync`. Takes an already-connected
 * `@tursodatabase/sync` client — never a path — so this class stays fs-free.
 * Migrations are *not* run here: call `runDatasetMigrations` (from `./db/migrate.ts`)
 * against the same client first.
 */
export class TursoDatasetProvider implements DatasetProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;

  /** Answers `query` — see the constructor's `runQuery`. */
  private readonly runQuery: ReadOnlyQueryRunner;
  private readonly db: ReturnType<
    typeof drizzle<Record<string, never>, Database>
  >;
  private readonly watchers = new Set<(event: DatasetChangeEvent) => void>();

  /** Tail of the serialized-write chain — as `TursoTraceProvider.serializeWrite`. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor({
    client,
    runQuery,
    id = "turso-datasets",
    displayName = "Datasets",
    description = "Stores datasets in a (optionally synced) SQLite database.",
  }: {
    /** An already-connected, migrated `@tursodatabase/sync` client. */
    client: Database;
    /**
     * Runs ad-hoc queries. Defaults to running them on `client` itself,
     * queued behind its writes; a store over a database file passes
     * `runQueryInWorker` for that file instead, so a slow query can't block
     * the event loop.
     */
    runQuery?: ReadOnlyQueryRunner;
    id?: string;
    displayName?: string;
    description?: string;
  }) {
    this.id = id;
    this.displayName = displayName;
    this.description = description;
    this.db = drizzle({ client });
    // Read-only mode is a per-connection pragma no write may run under, so a
    // query on the store's own connection waits its turn on the write chain.
    this.runQuery =
      runQuery ??
      ((query, options) =>
        this.serializeWrite(() => runReadOnlyQuery(client, query, options)));
  }

  /**
   * Runs a write to completion before the next one starts: the client is a
   * single connection, and overlapping transactions on it fail outright.
   */
  private serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => {});
    return next;
  }

  private emit(event: DatasetChangeEvent): void {
    for (const watcher of this.watchers) watcher(event);
  }

  watch(callback: (event: DatasetChangeEvent) => void): () => void {
    this.watchers.add(callback);
    return () => this.watchers.delete(callback);
  }

  async listDatasets(): Promise<DatasetSummary[]> {
    // A grouped subquery joined back, rather than a correlated `count(*)`
    // column — see `TursoTraceProvider.getAllTraces` for why.
    const counts = this.db
      .select({
        datasetId: datasetRows.datasetId,
        count: sql`count(*)`.as("count"),
      })
      .from(datasetRows)
      .groupBy(datasetRows.datasetId)
      .as("row_counts");

    const rows = await this.db
      .select({
        id: datasets.id,
        name: datasets.name,
        fields: datasets.fields,
        prompt: datasets.prompt,
        updatedAt: datasets.updatedAt,
        rowCount: sql<number>`coalesce(${counts.count}, 0)`,
      })
      .from(datasets)
      .leftJoin(counts, eq(counts.datasetId, datasets.id))
      .orderBy(desc(datasets.updatedAt));

    return rows.map(row => ({
      providerId: this.id,
      id: row.id,
      name: row.name,
      rowCount: Number(row.rowCount),
      fields: JSON.parse(row.fields) as DatasetField[],
      ...(row.prompt && { prompt: parseJson<PromptID>(row.prompt) }),
      updatedAt: row.updatedAt,
    }));
  }

  async getDataset(datasetId: string): Promise<Dataset | undefined> {
    const [row] = await this.db
      .select()
      .from(datasets)
      .where(eq(datasets.id, datasetId));
    return row ? rowToDataset(row) : undefined;
  }

  async listRows(
    datasetId: string,
    { offset = 0, limit }: ListRowsOptions = {},
  ): Promise<DatasetRow[]> {
    const rows = await this.db
      .select({
        id: datasetRows.id,
        cells: jsonColumn(datasetRows.cells),
        source: jsonColumn(datasetRows.source),
        createdAt: datasetRows.createdAt,
      })
      .from(datasetRows)
      .where(eq(datasetRows.datasetId, datasetId))
      // Rows added in one call share a timestamp; `rowid` keeps them in the
      // order they were given.
      .orderBy(asc(datasetRows.createdAt), sql`rowid`)
      // SQLite takes an OFFSET only after a LIMIT. Drizzle drops SQLite's
      // own "no limit", -1, so no limit is spelled as a limit nothing hits.
      .limit(limit ?? Number.MAX_SAFE_INTEGER)
      .offset(offset);

    return rows.map(row => ({
      id: row.id,
      cells: parseJson<Record<string, ExecutionInput>>(row.cells) ?? {},
      ...(row.source && { source: parseJson<DatasetRowSource>(row.source) }),
      createdAt: row.createdAt,
    }));
  }

  async describeRows(datasetId: string): Promise<DatasetRowsOverview> {
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(datasetRows)
      .where(eq(datasetRows.datasetId, datasetId));

    // One level into each cell, wherever that level lives: a resource's
    // `args`, an object's `properties`, or those of a typed-in object value.
    // They share a namespace per field, since a table shows any of them as
    // columns under the field. Ordered by the first row a key appears in,
    // then its position there — near enough to declaration order.
    const found = await this.db.all<{ field: string; key: string }>(sql`
      SELECT field.key AS field, inner_key.key AS key
      FROM ${datasetRows},
        json_each(${datasetRows.cells}) AS field,
        json_each(
          field.value,
          CASE json_extract(field.value, '$.kind')
            WHEN 'resource' THEN '$.args'
            WHEN 'object' THEN '$.properties'
            ELSE '$.value.properties'
          END
        ) AS inner_key
      WHERE ${datasetRows.datasetId} = ${datasetId}
      GROUP BY field.key, inner_key.key
      ORDER BY field.key, min(${datasetRows}.rowid), min(inner_key.id)
    `);

    // Whether each field is ever filled by a resource — over every cell,
    // including those of a resource that takes no arguments.
    const resources = await this.db.all<{
      field: string;
      resource: number;
    }>(sql`
      SELECT
        field.key AS field,
        max(json_extract(field.value, '$.kind') = 'resource') AS resource
      FROM ${datasetRows}, json_each(${datasetRows.cells}) AS field
      WHERE ${datasetRows.datasetId} = ${datasetId}
      GROUP BY field.key
    `);
    const isResource = new Set(
      resources.filter(r => Number(r.resource) === 1).map(r => r.field),
    );

    const fields: Record<string, DatasetFieldShape> = {};
    for (const { field, key } of found) {
      fields[field] ??= {
        keys: [],
        ...(isResource.has(field) && { resource: true }),
      };
      fields[field].keys.push(key);
    }
    return { rowCount: Number(count), fields };
  }

  async createDataset(
    input: CreateDatasetInput,
    options: TursoCreateDatasetOptions = {},
  ): Promise<Dataset> {
    const dataset = await this.serializeWrite(async () => {
      let id = options.id;
      if (!id) {
        const existing = new Set(
          (await this.db.select({ id: datasets.id }).from(datasets)).map(
            r => r.id,
          ),
        );
        id = uniqueDatasetId(slugifyDatasetName(input.name), taken =>
          existing.has(taken),
        );
      }
      const now = Date.now();
      const created: Dataset = {
        id,
        name: input.name,
        fields: input.fields.map((field, i) => ({
          id: fieldIdFor(i),
          def: field.def,
        })),
        ...(input.prompt && { prompt: input.prompt }),
        createdAt: now,
        updatedAt: now,
      };
      await this.db.insert(datasets).values({
        id: created.id,
        name: created.name,
        fields: JSON.stringify(created.fields),
        nextFieldId: created.fields.length,
        prompt: created.prompt ? JSON.stringify(created.prompt) : null,
        createdAt: now,
        updatedAt: now,
      });
      return created;
    });
    this.emit({ type: "add", datasetId: dataset.id });
    return dataset;
  }

  async renameDataset(datasetId: string, name: string): Promise<Dataset> {
    const dataset = await this.serializeWrite(async () => {
      await this.db
        .update(datasets)
        .set({ name, updatedAt: Date.now() })
        .where(eq(datasets.id, datasetId));
      const renamed = await this.getDataset(datasetId);
      if (!renamed) throw new DatasetNotFoundError(datasetId);
      return renamed;
    });
    this.emit({ type: "update", datasetId });
    return dataset;
  }

  async deleteDataset(datasetId: string): Promise<void> {
    const deleted = await this.serializeWrite(() =>
      this.db.transaction(async tx => {
        // `ON DELETE CASCADE` covers this on a client with foreign keys on
        // (`createLocalTursoClient` turns them on); deleting explicitly means
        // a client that didn't still can't strand rows.
        await tx
          .delete(datasetRows)
          .where(eq(datasetRows.datasetId, datasetId));
        const removed = await tx
          .delete(datasets)
          .where(eq(datasets.id, datasetId))
          .returning({ id: datasets.id });
        return removed.length > 0;
      }),
    );
    if (deleted) this.emit({ type: "remove", datasetId });
  }

  async addRows(
    datasetId: string,
    rows: NewDatasetRow[],
  ): Promise<DatasetRow[]> {
    const added = await this.serializeWrite(() =>
      this.db.transaction(async tx => {
        const [row] = await tx
          .select({ fields: datasets.fields })
          .from(datasets)
          .where(eq(datasets.id, datasetId));
        if (!row) throw new DatasetNotFoundError(datasetId);
        const fieldIds = new Set(
          (JSON.parse(row.fields) as DatasetField[]).map(f => f.id),
        );

        const now = Date.now();
        const minted: DatasetRow[] = rows.map(({ cells, source }) => {
          // Absent cells aren't stored: a missing field is a missing key.
          const present = Object.entries(cells).filter(
            ([, cell]) => cell !== undefined && cell !== null,
          );
          for (const [fieldId] of present) {
            if (!fieldIds.has(fieldId)) {
              throw new DatasetValidationError(
                `Dataset ${datasetId} has no field with id "${fieldId}"`,
              );
            }
          }
          return {
            id: mintRowId(),
            cells: Object.fromEntries(present),
            ...(source && { source }),
            createdAt: now,
          };
        });

        if (minted.length > 0) {
          await tx.insert(datasetRows).values(
            minted.map(r => ({
              id: r.id,
              datasetId,
              cells: r.cells,
              source: r.source ?? null,
              createdAt: r.createdAt,
            })),
          );
        }
        await tx
          .update(datasets)
          .set({ updatedAt: now })
          .where(eq(datasets.id, datasetId));
        return minted;
      }),
    );
    this.emit({ type: "update", datasetId });
    return added;
  }

  async updateRows(
    datasetId: string,
    updates: DatasetRowUpdate[],
  ): Promise<void> {
    // A batch that names no cells changes nothing, so it's not recorded:
    // no `updatedAt` bump, no change event.
    const changes = updates.some(u => Object.keys(u.cells).length > 0);
    await this.serializeWrite(() =>
      this.db.transaction(async tx => {
        const [row] = await tx
          .select({ fields: datasets.fields })
          .from(datasets)
          .where(eq(datasets.id, datasetId));
        if (!row) throw new DatasetNotFoundError(datasetId);
        const fieldIds = new Set(
          (JSON.parse(row.fields) as DatasetField[]).map(f => f.id),
        );

        // Everything is checked before anything is written, so a bad update
        // anywhere in the batch leaves every row as it was.
        for (const { cells } of updates) {
          for (const fieldId of Object.keys(cells)) {
            if (!fieldIds.has(fieldId)) {
              throw new DatasetValidationError(
                `Dataset ${datasetId} has no field with id "${fieldId}"`,
              );
            }
          }
        }
        const rowIds = [...new Set(updates.map(u => u.rowId))];
        if (rowIds.length > 0) {
          const found = await tx
            .select({ id: datasetRows.id })
            .from(datasetRows)
            .where(
              and(
                eq(datasetRows.datasetId, datasetId),
                inArray(datasetRows.id, rowIds),
              ),
            );
          const known = new Set(found.map(r => r.id));
          const missing = rowIds.find(id => !known.has(id));
          if (missing !== undefined) {
            throw new DatasetValidationError(
              `Dataset ${datasetId} has no row with id "${missing}"`,
            );
          }
        }

        for (const { rowId, cells } of updates) {
          const merged = mergedCells(cells);
          if (!merged) continue;
          await tx
            .update(datasetRows)
            .set({ cells: merged })
            .where(
              and(
                eq(datasetRows.id, rowId),
                eq(datasetRows.datasetId, datasetId),
              ),
            );
        }
        if (changes) {
          await tx
            .update(datasets)
            .set({ updatedAt: Date.now() })
            .where(eq(datasets.id, datasetId));
        }
      }),
    );
    if (changes) this.emit({ type: "update", datasetId });
  }

  async deleteRows(
    datasetId: string,
    rowIds: readonly string[],
  ): Promise<number> {
    if (rowIds.length === 0) return 0;
    const deleted = await this.serializeWrite(() =>
      this.db.transaction(async tx => {
        const removed = await tx
          .delete(datasetRows)
          .where(
            and(
              inArray(datasetRows.id, [...rowIds]),
              eq(datasetRows.datasetId, datasetId),
            ),
          )
          .returning({ id: datasetRows.id });
        if (removed.length === 0) return 0;
        await tx
          .update(datasets)
          .set({ updatedAt: Date.now() })
          .where(eq(datasets.id, datasetId));
        return removed.length;
      }),
    );
    if (deleted > 0) this.emit({ type: "update", datasetId });
    return deleted;
  }

  async addField(
    datasetId: string,
    def: PropDefinition,
  ): Promise<DatasetField> {
    const field = await this.serializeWrite(() =>
      this.db.transaction(async tx => {
        const [row] = await tx
          .select({
            fields: datasets.fields,
            nextFieldId: datasets.nextFieldId,
          })
          .from(datasets)
          .where(eq(datasets.id, datasetId));
        if (!row) throw new DatasetNotFoundError(datasetId);
        const fields = JSON.parse(row.fields) as DatasetField[];
        // Unique by §B's key, as derived fields are: the same name with a
        // different type is a different field.
        const exists = fields.some(f => matchKey(f.def) === matchKey(def));
        if (exists) {
          throw new DatasetValidationError(
            `\`${def.name}: ${def.type.syntax}\` already exists`,
          );
        }
        const added: DatasetField = {
          id: fieldIdFor(row.nextFieldId),
          def,
          added: true,
        };
        await tx
          .update(datasets)
          .set({
            fields: JSON.stringify([...fields, added]),
            nextFieldId: row.nextFieldId + 1,
            updatedAt: Date.now(),
          })
          .where(eq(datasets.id, datasetId));
        return added;
      }),
    );
    this.emit({ type: "update", datasetId });
    return field;
  }

  async renameField(
    datasetId: string,
    fieldId: string,
    name: string,
  ): Promise<DatasetField> {
    const field = await this.serializeWrite(() =>
      this.db.transaction(async tx => {
        const fields = await this.fieldsIn(tx, datasetId);
        const field = fields.find(f => f.id === fieldId);
        if (!field) throw noSuchField(datasetId, fieldId);
        const renamed: DatasetField = { ...field, def: { ...field.def, name } };
        const clash = fields.some(
          f => f.id !== fieldId && matchKey(f.def) === matchKey(renamed.def),
        );
        if (clash) {
          throw new DatasetValidationError(
            `\`${name}: ${field.def.type.syntax}\` already exists`,
          );
        }
        await tx
          .update(datasets)
          .set({
            fields: JSON.stringify(
              fields.map(f => (f.id === fieldId ? renamed : f)),
            ),
            updatedAt: Date.now(),
          })
          .where(eq(datasets.id, datasetId));
        return renamed;
      }),
    );
    this.emit({ type: "update", datasetId });
    return field;
  }

  async deleteField(datasetId: string, fieldId: string): Promise<void> {
    await this.serializeWrite(() =>
      this.db.transaction(async tx => {
        const fields = await this.fieldsIn(tx, datasetId);
        if (!fields.some(f => f.id === fieldId)) {
          throw noSuchField(datasetId, fieldId);
        }
        // `nextFieldId` is left alone, so the id is never minted again: a
        // row written before the delete can't come back under a new field.
        await tx
          .update(datasets)
          .set({
            fields: JSON.stringify(fields.filter(f => f.id !== fieldId)),
            updatedAt: Date.now(),
          })
          .where(eq(datasets.id, datasetId));
        await tx
          .update(datasetRows)
          .set({
            cells: sql`jsonb_remove(${datasetRows.cells}, ${`$."${fieldId}"`})`,
          })
          .where(eq(datasetRows.datasetId, datasetId));
      }),
    );
    this.emit({ type: "update", datasetId });
  }

  /**
   * Runs one read-only query against a `rows` view of the dataset (see
   * `./dataset-query.ts`). Queued on the write chain, as
   * `TursoTraceProvider.query` is.
   */
  async queryRows(
    datasetId: string,
    query: string,
    options?: SqlQueryOptions,
  ): Promise<SqlQueryResult> {
    const dataset = await this.getDataset(datasetId);
    if (!dataset) throw new DatasetNotFoundError(datasetId);
    return this.runQuery(
      datasetRowsQuery(datasetId, dataset.fields, query),
      options,
    );
  }

  /** A dataset's fields, read inside `tx`; throws if it doesn't exist. */
  private async fieldsIn(
    tx: Pick<typeof this.db, "select">,
    datasetId: string,
  ): Promise<DatasetField[]> {
    const [row] = await tx
      .select({ fields: datasets.fields })
      .from(datasets)
      .where(eq(datasets.id, datasetId));
    if (!row) throw new DatasetNotFoundError(datasetId);
    return JSON.parse(row.fields) as DatasetField[];
  }
}

function noSuchField(datasetId: string, fieldId: string): Error {
  return new DatasetValidationError(
    `Dataset ${datasetId} has no field with id "${fieldId}"`,
  );
}
