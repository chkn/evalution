// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * {@link DatasetProvider} backed by a Turso/libSQL database. Holds any number
 * of datasets, keyed by `dataset_id` — the class a cloud project DB uses
 * as-is. {@link LocalDirectoryDatasetProvider} composes one of these per file
 * for the local one-file-per-dataset layout. See `specs/datasets.md` §E.
 */

import type { Database } from "@tursodatabase/sync";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import type { ExecutionInput } from "../shared/types.ts";
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
  type NewDatasetRow,
} from "./dataset-provider.ts";
import type {
  Dataset,
  DatasetChangeEvent,
  DatasetField,
  DatasetRow,
  DatasetRowSource,
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

  private readonly db: ReturnType<
    typeof drizzle<Record<string, never>, Database>
  >;
  private readonly watchers = new Set<(event: DatasetChangeEvent) => void>();

  /** Tail of the serialized-write chain — as `TursoTraceProvider.serializeWrite`. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor({
    client,
    id = "turso-datasets",
    displayName = "Datasets",
    description = "Stores datasets in a (optionally synced) SQLite database.",
  }: {
    /** An already-connected, migrated `@tursodatabase/sync` client. */
    client: Database;
    id?: string;
    displayName?: string;
    description?: string;
  }) {
    this.id = id;
    this.displayName = displayName;
    this.description = description;
    this.db = drizzle({ client });
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

  async listRows(datasetId: string): Promise<DatasetRow[]> {
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
      .orderBy(asc(datasetRows.createdAt), sql`rowid`);

    return rows.map(row => ({
      id: row.id,
      cells: parseJson<Record<string, ExecutionInput>>(row.cells) ?? {},
      ...(row.source && { source: parseJson<DatasetRowSource>(row.source) }),
      createdAt: row.createdAt,
    }));
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

  async deleteRow(datasetId: string, rowId: string): Promise<void> {
    const deleted = await this.serializeWrite(() =>
      this.db.transaction(async tx => {
        const removed = await tx
          .delete(datasetRows)
          .where(
            and(
              eq(datasetRows.id, rowId),
              eq(datasetRows.datasetId, datasetId),
            ),
          )
          .returning({ id: datasetRows.id });
        if (removed.length === 0) return false;
        await tx
          .update(datasets)
          .set({ updatedAt: Date.now() })
          .where(eq(datasets.id, datasetId));
        return true;
      }),
    );
    if (deleted) this.emit({ type: "update", datasetId });
  }
}
