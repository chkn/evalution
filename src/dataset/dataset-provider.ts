// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropDefinition } from "../shared/types.ts";
import type {
  SqlQueryOptions,
  SqlQueryResult,
} from "../trace/db/read-only-query.ts";
import type { PromptID } from "../trace/trace-types.ts";
import type {
  Dataset,
  DatasetChangeEvent,
  DatasetField,
  DatasetRow,
  DatasetRowsOverview,
  DatasetRowUpdate,
  DatasetSummary,
} from "./dataset-types.ts";

/** What {@link DatasetProvider.createDataset} takes. */
export interface CreateDatasetInput {
  name: string;
  /** The schema. Ids are minted by the provider. */
  fields: Omit<DatasetField, "id">[];
  /** The prompt this dataset is created from, if any. */
  prompt?: PromptID;
}

/**
 * Which rows {@link DatasetProvider.listRows} returns: a window onto the
 * dataset's rows in their stable order (oldest first). Sorting and filtering,
 * when they come, belong here too, so paging keeps meaning "a window onto the
 * ordered, filtered rows".
 */
export interface ListRowsOptions {
  /** How many rows to skip. Defaults to 0. */
  offset?: number;
  /** The most rows to return. Defaults to all of them. */
  limit?: number;
}

/** A row as {@link DatasetProvider.addRows} takes it: id and timestamp are minted. */
export type NewDatasetRow = Pick<DatasetRow, "cells" | "source">;

/** Thrown by a {@link DatasetProvider} when the dataset named doesn't exist. */
export class DatasetNotFoundError extends Error {
  override name = "DatasetNotFoundError";
  constructor(datasetId: string) {
    super(`Dataset not found: ${datasetId}`);
  }
}

/**
 * Thrown by a {@link DatasetProvider} when a write doesn't fit the dataset —
 * a cell naming a field the dataset doesn't have, say.
 */
export class DatasetValidationError extends Error {
  override name = "DatasetValidationError";
}

/**
 * A store of datasets: named, schema'd collections of input rows used to
 * exercise prompts. Parallel to `PromptProvider` and `TraceProvider`.
 *
 * Reads and writes are one interface, unlike traces: dataset writes come from
 * the user over REST rather than from an ingestor, and a read-only dataset
 * store has no motivating case. See `specs/datasets.md` §E.
 */
export interface DatasetProvider {
  /**
   * Uniquely identifies this instance, even when multiple providers of the
   * same type are used.
   */
  readonly id: string;

  /** Human-readable name shown when choosing between providers. */
  readonly displayName?: string;

  /** Short description of what this provider offers. */
  readonly description?: string;

  /** Summaries of every dataset, most recently updated first. */
  listDatasets(): Promise<DatasetSummary[]>;

  /** A dataset's metadata and schema, or `undefined` if it doesn't exist. */
  getDataset(datasetId: string): Promise<Dataset | undefined>;

  /**
   * A dataset's rows, oldest first — all of them, or the window `options`
   * names. Empty for an unknown dataset.
   */
  listRows(datasetId: string, options?: ListRowsOptions): Promise<DatasetRow[]>;

  /**
   * How many rows a dataset has and which keys its cells hold, without
   * reading the rows out. Zero rows and no keys for an unknown dataset.
   */
  describeRows(datasetId: string): Promise<DatasetRowsOverview>;

  /** Creates a dataset, minting its id and field ids. */
  createDataset(input: CreateDatasetInput): Promise<Dataset>;

  /** Renames a dataset. Its id never changes. */
  renameDataset(datasetId: string, name: string): Promise<Dataset>;

  /** Deletes a dataset and all its rows. A no-op if it doesn't exist. */
  deleteDataset(datasetId: string): Promise<void>;

  /**
   * Appends rows, minting ids and timestamps. Every cell must name an
   * existing field id; a row that doesn't is rejected, and none are added.
   */
  addRows(datasetId: string, rows: NewDatasetRow[]): Promise<DatasetRow[]>;

  /**
   * Sets or clears cells on several rows at once. `null` clears, removing the
   * key so rows stay sparse; cells not named are untouched. Only `value`
   * cells may be set: nothing in the dataset view can produce any other kind.
   *
   * All or nothing: an update naming a row or field the dataset doesn't have,
   * or setting a non-`value` cell, rejects the whole batch with a
   * {@link DatasetValidationError}, and no row changes.
   */
  updateRows(datasetId: string, updates: DatasetRowUpdate[]): Promise<void>;

  /**
   * Deletes rows, all at once: either every listed row that exists is gone
   * afterwards or, if this fails, none is. Ids of rows that don't exist are
   * skipped. Resolves to how many rows were deleted.
   */
  deleteRows(datasetId: string, rowIds: readonly string[]): Promise<number>;

  /**
   * Appends a field, minting its id from the dataset's never-decreasing
   * counter. Rows are untouched: the new column starts empty. A field with
   * the same name and `type.syntax` as an existing one is rejected with a
   * {@link DatasetValidationError}; the same name with a different type is
   * allowed. See `specs/datasets.md` §B, §P.1.
   */
  addField(datasetId: string, def: PropDefinition): Promise<DatasetField>;

  /**
   * Renames a field. Its id never changes, so rows are untouched. A name that
   * would give the field the same name and `type.syntax` as another is
   * rejected with a {@link DatasetValidationError}, as is an unknown field.
   *
   * Optional — the REST and MCP handlers report "not supported" without it.
   */
  renameField?(
    datasetId: string,
    fieldId: string,
    name: string,
  ): Promise<DatasetField>;

  /**
   * Deletes a field and every row's cell for it. Its id is never reused. An
   * unknown field is rejected with a {@link DatasetValidationError}.
   *
   * Optional — as {@link renameField}.
   */
  deleteField?(datasetId: string, fieldId: string): Promise<void>;

  /**
   * Runs one read-only SQL query against a `rows` view of a dataset's rows —
   * a column per field, named after it, plus `_id`, `_created_at`,
   * `_source`, and `_cells` (see `./dataset-query.ts`). Writes are refused.
   *
   * Optional — a store not backed by SQL omits it.
   */
  queryRows?(
    datasetId: string,
    sql: string,
    options?: SqlQueryOptions,
  ): Promise<SqlQueryResult>;

  /**
   * Registers a callback invoked whenever a dataset is added, changed, or
   * removed. Optional — as `TraceProvider.watch`.
   *
   * @returns A no-argument function that unregisters the watcher.
   */
  watch?(callback: (event: DatasetChangeEvent) => void): () => void;
}
