// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Merging a dataset file into the cloud's copy of the same dataset, when a
 * machine starts syncing one it already has (see `local-database.ts`). Both
 * may have rows, and both may have fields — minted independently, so the same
 * id can name different fields. The cloud's fields stay as they are; each
 * local field joins the one of the same name, or is added under a new id.
 */

import type { Database } from "@tursodatabase/sync";
import { copyTable } from "../../sync/local-database.ts";
import { fieldIdFor } from "../dataset-ids.ts";
import type { DatasetField } from "../dataset-types.ts";

interface DatasetRecord {
  id: string;
  fields: string;
  next_field_id: number;
}

async function datasetIn(db: Database): Promise<DatasetRecord | undefined> {
  return (
    await db.prepare("SELECT id, fields, next_field_id FROM datasets LIMIT 1")
  ).get() as Promise<DatasetRecord | undefined>;
}

/**
 * The cloud's fields with the local ones added, and what each local field's
 * id becomes.
 */
export function unionFields(
  remote: DatasetField[],
  remoteNextId: number,
  local: DatasetField[],
): { fields: DatasetField[]; nextFieldId: number; ids: Map<string, string> } {
  const fields = [...remote];
  const byName = new Map(remote.map(field => [field.def.name, field.id]));
  const ids = new Map<string, string>();
  let nextFieldId = remoteNextId;
  for (const field of local) {
    const same = byName.get(field.def.name);
    if (same !== undefined) {
      ids.set(field.id, same);
      continue;
    }
    const id = fieldIdFor(nextFieldId++);
    ids.set(field.id, id);
    byName.set(field.def.name, id);
    fields.push({ ...field, id });
  }
  return { fields, nextFieldId, ids };
}

/**
 * Merges the dataset in `from` into the one in `into`, for `copyRows`. With
 * no dataset on one side, there's nothing to reconcile: the generic copy
 * does.
 */
export async function mergeDatasetTables(
  from: Database,
  into: Database,
): Promise<string[]> {
  const local = await datasetIn(from);
  const remote = await datasetIn(into);
  if (!local || !remote) return [];
  const { fields, nextFieldId, ids } = unionFields(
    JSON.parse(remote.fields),
    remote.next_field_id,
    JSON.parse(local.fields),
  );
  if (nextFieldId !== remote.next_field_id) {
    await (
      await into.prepare(
        "UPDATE datasets SET fields = ?, next_field_id = ?, updated_at = ? WHERE id = ?",
      )
    ).run(JSON.stringify(fields), nextFieldId, Date.now(), remote.id);
  }
  await copyTable(from, into, "dataset_rows", {
    read: { cells: "json(cells)" },
    write: { cells: "jsonb(?)" },
    map: row => ({
      ...row,
      dataset_id: remote.id,
      // A cell of a field deleted here has nowhere to go: its id may name
      // another field in the cloud's copy.
      cells: JSON.stringify(
        Object.fromEntries(
          Object.entries(JSON.parse(String(row.cells))).flatMap(
            ([id, value]) => {
              const to = ids.get(id);
              return to === undefined ? [] : [[to, value]];
            },
          ),
        ),
      ),
    }),
  });
  return ["datasets", "dataset_rows"];
}
