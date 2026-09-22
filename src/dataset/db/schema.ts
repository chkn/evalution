// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Drizzle sqlite-core schema backing {@link TursoDatasetProvider}. See
 * `specs/datasets.md` §F. Carries `dataset_id` even though a local file holds
 * one dataset, so a cloud project DB can hold every dataset with this schema
 * verbatim. fs-free by construction, like its trace sibling.
 */

import { type SQLWrapper, sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * A JSON value stored as SQLite JSONB.
 *
 * The conversion happens in SQLite (`jsonb(?)`), not here: Drizzle's
 * `blob({ mode: "json" })` stores JSON *text* in a blob, which is neither
 * smaller nor JSONB. `jsonb()` also rejects malformed JSON, a last line of
 * defense under the server's validation. Reads must select `json(column)` —
 * a JSONB blob can't be decoded outside SQLite — so this column type has no
 * `fromDriver`; see {@link jsonColumn}.
 */
const jsonb = customType<{ data: unknown; driverData: Uint8Array }>({
  dataType: () => "blob",
  toDriver: value => sql`jsonb(${JSON.stringify(value)})`,
});

/** Selects a {@link jsonb} column back as JSON text. */
export const jsonColumn = (column: SQLWrapper) =>
  sql<string | null>`json(${column})`;

/** One {@link Dataset}: its metadata and schema. */
export const datasets = sqliteTable("datasets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** JSON `DatasetField[]`. Text: one row per dataset, and readable in `sqlite3`. */
  fields: text("fields").notNull(),
  /** The next field id's counter value — see `DatasetField.id`. Never decreases. */
  nextFieldId: integer("next_field_id").notNull(),
  /** JSON `PromptID`. */
  prompt: text("prompt"),
  /** Creation timestamp (ms). */
  createdAt: real("created_at").notNull(),
  /** Last-change timestamp (ms). */
  updatedAt: real("updated_at").notNull(),
});

/**
 * One {@link DatasetRow}. The one table that grows without bound, so what
 * repeats per row is kept small: JSONB cells keyed by short field ids, short
 * random row ids, and no key at all for an absent cell.
 */
export const datasetRows = sqliteTable(
  "dataset_rows",
  {
    /** Short random id — minted independently so offline replicas can't collide. */
    id: text("id").primaryKey(),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    /** JSONB `Record<fieldId, ExecutionInput>`. */
    cells: jsonb("cells").notNull(),
    /** JSONB `DatasetRowSource`. */
    source: jsonb("source"),
    /** Creation timestamp (ms). */
    createdAt: real("created_at").notNull(),
  },
  t => [index("idx_dataset_rows_dataset").on(t.datasetId, t.createdAt)],
);
