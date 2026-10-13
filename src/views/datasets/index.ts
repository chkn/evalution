// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * **evalution/views/datasets** — pure helpers that compute the updates a
 * dataset view proposes, so every editor of a row's resource instances
 * doesn't rewrite the same reference bookkeeping. Browser-safe and
 * framework-free. The host checks proposals with the same helpers. See
 * `specs/dataset-views.md` §D.
 *
 * @module evalution/views/datasets
 */

import type {
  DatasetRow,
  DatasetRowUpdate,
} from "../../dataset/dataset-types.ts";
import { isValidInstanceName } from "../../shared/instance-names.ts";
import type {
  ExecutionInput,
  ResourceInstanceInput,
} from "../../shared/types.ts";

export {
  type ColumnPath,
  childInputs,
  fieldPath,
  type InstanceArgument,
  instancePath,
  MAX_REFERENCE_HOPS,
  type PathRow,
  type PathValue,
  type ResolvedPath,
  readColumnPath,
  resolveColumnPath,
} from "../../shared/column-paths.ts";

/** Where an instance reference sits in a row. */
export type ReferenceSite =
  /** In a cell, at `path` inside it (empty for the cell itself). */
  | { cell: string; path: string[] }
  /** In one of an instance's arguments, at `path` inside it. */
  | { instance: string; arg: string; path: string[] };

/** One instance reference in a row: from where, to which instance and output. */
export interface Reference {
  from: ReferenceSite;
  /** The instance referred to. */
  to: string;
  /** The output read, if not the instance's value itself. */
  output?: string;
}

/** Every instance reference inside `input`, with the path to it. */
function referencesIn(
  input: ExecutionInput,
  path: string[],
  site: (path: string[]) => ReferenceSite,
  out: Reference[],
): void {
  switch (input.kind) {
    case "instance":
      out.push({
        from: site(path),
        to: input.name,
        ...(input.output !== undefined && { output: input.output }),
      });
      break;
    case "object":
      for (const [key, child] of Object.entries(input.properties)) {
        referencesIn(child, [...path, key], site, out);
      }
      break;
  }
}

/** Every instance reference in the row: from where, to which instance and output. */
export function references(
  row: Pick<DatasetRow, "cells" | "resources">,
): Reference[] {
  const out: Reference[] = [];
  for (const [cell, input] of Object.entries(row.cells)) {
    referencesIn(input, [], path => ({ cell, path }), out);
  }
  for (const [instance, spec] of Object.entries(row.resources ?? {})) {
    for (const [arg, input] of Object.entries(spec.args ?? {})) {
      referencesIn(input, [], path => ({ instance, arg, path }), out);
    }
  }
  return out;
}

/** The references in the row to instances it doesn't declare. */
export function danglingReferences(
  row: Pick<DatasetRow, "cells" | "resources">,
): Reference[] {
  const declared = row.resources ?? {};
  return references(row).filter(r => !Object.hasOwn(declared, r.to));
}

/** A reference's site as one line of text, for messages. */
export function describeReference(ref: Reference): string {
  const inside = ref.from.path.length ? ` › ${ref.from.path.join(" › ")}` : "";
  const where =
    "cell" in ref.from
      ? `cell ${ref.from.cell}${inside}`
      : `${ref.from.instance}'s ${ref.from.arg}${inside}`;
  return `${where} → ${ref.to}${ref.output ? `.${ref.output}` : ""}`;
}

/** `hint` as an instance name: camelCased words, or `instance` if none survive. */
function nameFromHint(hint: string): string {
  const words = hint
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 4);
  const name = words
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toLowerCase() + w.slice(1)
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
  return isValidInstanceName(name) ? name : `instance${name}`;
}

/**
 * Adds an instance under a fresh valid name based on `hint` (`"Brand kit"`
 * → `brandKit`, then `brandKit2`, …). Returns the name and the update.
 */
export function addInstance(
  row: Pick<DatasetRow, "id" | "resources">,
  instance: ResourceInstanceInput,
  hint = "instance",
): { name: string; update: DatasetRowUpdate } {
  const base = nameFromHint(hint);
  const taken = row.resources ?? {};
  let name = base;
  for (let n = 2; Object.hasOwn(taken, name); n++) name = `${base}${n}`;
  return {
    name,
    update: { rowId: row.id, cells: {}, resources: { [name]: instance } },
  };
}

/**
 * Replaces some of an instance's arguments; `null` removes one.
 *
 * @throws when the row declares no instance `name`.
 */
export function setArgs(
  row: Pick<DatasetRow, "id" | "resources">,
  name: string,
  args: Record<string, ExecutionInput | null>,
): DatasetRowUpdate {
  const spec = row.resources?.[name];
  if (!spec) throw new Error(`This row has no instance '${name}'`);
  const next: Record<string, ExecutionInput> = { ...spec.args };
  for (const [arg, value] of Object.entries(args)) {
    if (value === null) delete next[arg];
    else next[arg] = value;
  }
  const { args: _, receipt: __, ...rest } = spec;
  return {
    rowId: row.id,
    cells: {},
    resources: {
      [name]: { ...rest, ...(Object.keys(next).length > 0 && { args: next }) },
    },
  };
}

/**
 * Removes instances — or, when anything left in the row still refers to
 * one of them (a cell, another instance), reports those references and
 * changes nothing.
 */
export function removeInstances(
  row: Pick<DatasetRow, "id" | "cells" | "resources">,
  names: readonly string[],
): DatasetRowUpdate | { dangling: Reference[] } {
  const removing = new Set(names);
  const dangling = references(row).filter(
    r =>
      removing.has(r.to) &&
      !("instance" in r.from && removing.has(r.from.instance)),
  );
  if (dangling.length > 0) return { dangling };
  return {
    rowId: row.id,
    cells: {},
    resources: Object.fromEntries(names.map(n => [n, null])),
  };
}
