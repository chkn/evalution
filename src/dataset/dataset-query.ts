// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Ad-hoc SQL over one dataset's rows (`DatasetProvider.queryRows`). Rows are
 * stored as JSONB cells keyed by field id, which is no shape to write a query
 * against, so the caller's query runs against a `rows` view with one column
 * per field, named after it. Pure: SQL strings in, SQL strings out.
 */

import type { DatasetField } from "./dataset-types.ts";

/** One column of the `rows` view a dataset query runs against. */
export interface DatasetQueryColumn {
  /** The column's name in the `rows` view. */
  column: string;
  /** The field it shows, or absent for the built-in `_id`, `_created_at`, … */
  fieldId?: string;
  /** What the column holds. */
  description: string;
}

/** The view's built-in columns, before the per-field ones. */
const BUILT_IN_COLUMNS: DatasetQueryColumn[] = [
  { column: "_id", description: "The row's id." },
  {
    column: "_created_at",
    description: "When the row was added, in ms since the Unix epoch.",
  },
  {
    column: "_source",
    description:
      "JSON: where the row came from ({kind: 'playground', promptId, providerId} or {kind: 'trace', traceId, traceProviderId}), or NULL.",
  },
  {
    column: "_cells",
    description:
      "JSON: every cell, keyed by field id, exactly as stored (each an ExecutionInput).",
  },
];

/**
 * The columns of the `rows` view for a dataset with `fields`: the built-ins,
 * then one per field, named after it. A field whose name is already taken —
 * a second field of the same name and a different type — is named
 * `<name>#<fieldId>` instead.
 */
export function datasetQueryColumns(
  fields: readonly DatasetField[],
): DatasetQueryColumn[] {
  const taken = new Set(BUILT_IN_COLUMNS.map(c => c.column));
  const columns = [...BUILT_IN_COLUMNS];
  for (const field of fields) {
    const name = taken.has(field.def.name)
      ? `${field.def.name}#${field.id}`
      : field.def.name;
    taken.add(name);
    columns.push({
      column: name,
      fieldId: field.id,
      description: `Field "${field.def.name}: ${field.def.type.syntax}". A typed-in primitive reads as its plain value (text, number, or 0/1); any other cell reads as JSON.`,
    });
  }
  return columns;
}

/** `value` as a SQL string literal. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** `name` as a SQL identifier. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The expression for one field's column: the plain value of a typed-in
 * primitive, else the cell (or the typed-in value) as JSON. Field ids are
 * base-36, so they need no escaping inside the quoted path.
 */
function fieldExpression(cellsColumn: string, fieldId: string): string {
  const path = (suffix: string) =>
    `json_extract(${cellsColumn}, '$."${fieldId}"${suffix}')`;
  return `CASE ${path(".kind")}
      WHEN 'value' THEN CASE ${path(".value.kind")}
        WHEN 'primitive' THEN ${path(".value.value")}
        ELSE json(${path(".value")})
      END
      ELSE json(${path("")})
    END`;
}

/** Matches a query's leading `WITH [RECURSIVE]`, so the `rows` view can join its CTEs. */
const LEADING_WITH = /^\s*with(\s+recursive)?\s/i;

/**
 * `query` with a `rows` CTE in front of it holding dataset `datasetId`'s rows,
 * one column per {@link datasetQueryColumns}, oldest first. A query that
 * opens with its own `WITH` gets `rows` added to its list rather than a
 * second `WITH`, which SQL doesn't allow.
 *
 * @param tables - The physical table names, so a store that renames them
 *   still gets a working view.
 */
export function datasetRowsQuery(
  datasetId: string,
  fields: readonly DatasetField[],
  query: string,
  tables: { rows: string } = { rows: "dataset_rows" },
): string {
  const select = datasetQueryColumns(fields)
    .filter(c => c.fieldId !== undefined)
    .map(
      c =>
        `${fieldExpression("cells", c.fieldId as string)} AS ${identifier(c.column)}`,
    );
  const view = `rows AS (
  SELECT
    id AS _id,
    created_at AS _created_at,
    json(source) AS _source,
    json(cells) AS _cells${select.map(s => `,\n    ${s}`).join("")}
  FROM ${identifier(tables.rows)}
  WHERE dataset_id = ${literal(datasetId)}
  ORDER BY created_at, rowid
)`;
  const leading = LEADING_WITH.exec(query);
  if (leading) {
    return `WITH${leading[1] ?? ""} ${view},\n${query.slice(leading[0].length)}`;
  }
  return `WITH ${view}\n${query}`;
}
