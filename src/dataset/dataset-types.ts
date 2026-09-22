// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The data model of datasets: named, schema'd collections of input rows used
 * to exercise prompts. See `specs/datasets.md`.
 */

import type { ExecutionInput, PropDefinition } from "../shared/types.ts";
import type { PromptID } from "../trace/trace-types.ts";

/**
 * One column of a {@link Dataset}.
 *
 * Fields are always derived — copied from a prompt parameter or from a trace's
 * recorded definition — never typed in: a dataset belongs to no file, so there
 * is no checker to resolve a hand-written type against.
 */
export interface DatasetField {
  /**
   * Stable, short id — row cells are keyed by it, so renaming a field never
   * rewrites rows. Base-36 of a per-dataset counter (`0`–`9`, `a`–`z`, `10`,
   * …), minted by the provider and never reused.
   */
  id: string;
  /** Name, type, description — the checker's view of the slot this field came from. */
  def: PropDefinition;
}

/**
 * A dataset's metadata and schema. Rows are fetched separately
 * ({@link DatasetProvider.listRows}), since they grow without bound.
 */
export interface Dataset {
  /** Stable id; for a local dataset, also the basename of its file. */
  id: string;
  /** Display name. Renaming changes only this, never {@link id}. */
  name: string;
  /** The schema, in display order. */
  fields: DatasetField[];
  /**
   * The prompt this dataset was created from, if any — metadata, not a
   * constraint. Stores the prompt's `globalId` when it has one, so the link
   * survives moves and renames; the server resolves it on read.
   */
  prompt?: PromptID;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** Timestamp (ms) of the last change to the dataset or its rows. */
  updatedAt: number;
}

/** Where a {@link DatasetRow} came from, so the view can link back to it. */
export type DatasetRowSource =
  | { kind: "playground"; promptId: string; providerId: string }
  | { kind: "trace"; traceId: string; traceProviderId: string };

/**
 * One dataset row: a cell per field it has a value for, keyed by field id.
 *
 * A cell is the same {@link ExecutionInput} the execute panel stores and a
 * trace records — so a resource reference, arguments and all, survives the
 * trip into a dataset and back out into the panel. Rows are sparse: a field
 * with no value has no key.
 */
export interface DatasetRow {
  id: string;
  /** Field id → the input for that field. Never carries a receipt. */
  cells: Record<string, ExecutionInput>;
  /** Where the row came from. */
  source?: DatasetRowSource;
  /** Creation timestamp (ms). */
  createdAt: number;
}

/** Compact dataset entry for listings (sidebar / `GET /api/datasets`). */
export interface DatasetSummary {
  providerId: string;
  id: string;
  name: string;
  rowCount: number;
  /**
   * The schema — small, and what an "add to dataset" menu needs to say how
   * much of a set of inputs would land. Empty for a dataset with an `error`.
   */
  fields: DatasetField[];
  /** See {@link Dataset.prompt}. Resolved to an openable reference when served. */
  prompt?: PromptID;
  /** Timestamp (ms) of the last change. */
  updatedAt: number;
  /**
   * Why this dataset can't be read, if it can't — a corrupt file, say. Listed
   * rather than hidden, so a broken dataset is visible instead of missing.
   */
  error?: string;
}

/** The kind of change a {@link DatasetChangeEvent} describes. */
export type DatasetChangeType = "add" | "update" | "remove";

/** Describes a single change emitted by `DatasetProvider.watch`. */
export interface DatasetChangeEvent {
  type: DatasetChangeType;
  datasetId: string;
}

/** Information about a registered dataset provider. */
export interface DatasetProviderInfo {
  id: string;
  displayName?: string;
  description?: string;
}
