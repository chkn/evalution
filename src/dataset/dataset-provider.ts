// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PromptID } from "../trace/trace-types.ts";
import type {
  Dataset,
  DatasetChangeEvent,
  DatasetField,
  DatasetRow,
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

  /** Every row of a dataset, oldest first. Empty for an unknown dataset. */
  listRows(datasetId: string): Promise<DatasetRow[]>;

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

  /** Deletes one row. A no-op if it doesn't exist. */
  deleteRow(datasetId: string, rowId: string): Promise<void>;

  /**
   * Registers a callback invoked whenever a dataset is added, changed, or
   * removed. Optional — as `TraceProvider.watch`.
   *
   * @returns A no-argument function that unregisters the watcher.
   */
  watch?(callback: (event: DatasetChangeEvent) => void): () => void;
}
