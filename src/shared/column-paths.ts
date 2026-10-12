// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Column paths: where a dataset column reads from in a row. Shared by the
 * grid, the server (which describes and validates paths) and dataset views,
 * which must all agree on what a path reads. Pure — no runtime
 * dependencies. See `specs/datasets.md` §Q.1.
 */

import type { ExecutionInput, ResourceInstanceInput } from "./types.ts";

/** Where a column reads from in a row. */
export interface ColumnPath {
  /** A field's cell, or one of the row's resource instances by name. */
  root: { field: string } | { instance: string };
  /** Steps inward, by name. Empty for the root itself. */
  keys: string[];
}

/** The parts of a row a path reads: its cells, and its resource instances. */
export interface PathRow {
  cells: Record<string, ExecutionInput>;
  resources?: Record<string, ResourceInstanceInput>;
}

/**
 * What a path reads in a row: the input there, `"absent"` when the row has
 * nothing at its root, or `"n/a"` when a step can't be taken.
 */
export type PathValue = ExecutionInput | "absent" | "n/a";

/**
 * How many instance references a path may step through before it gives up.
 * A row whose references form a cycle can't run, but nothing stops one from
 * being stored.
 */
export const MAX_REFERENCE_HOPS = 16;

/**
 * Where a path landed, when its last step was an instance's argument — what
 * an edit through it must change. See `specs/datasets.md` §Q.4.
 */
export interface InstanceArgument {
  /** The instance whose argument it is. */
  instance: string;
  /** The argument's name. */
  arg: string;
}

/** What {@link resolveColumnPath} found. */
export interface ResolvedPath {
  value: PathValue;
  /** Set when the last step read an instance's argument. */
  argument?: InstanceArgument;
}

/** A field's whole column. */
export function fieldPath(field: string, keys: string[] = []): ColumnPath {
  return { root: { field }, keys };
}

/** An instance's column. */
export function instancePath(
  instance: string,
  keys: string[] = [],
): ColumnPath {
  return { root: { instance }, keys };
}

/** The field a path is rooted at, or `undefined` for an instance root. */
export function pathField(path: ColumnPath): string | undefined {
  return "field" in path.root ? path.root.field : undefined;
}

/**
 * The inputs one step inward from `input`, by name, in order — what a path
 * can step to next:
 *
 * - a `value` holding an object `PropValue`: its properties, each wrapped as
 *   the value cell it would be on its own;
 * - an `object` cell: its properties;
 * - an `instance` reference: that instance's arguments, in the same row. Its
 *   `output` is ignored, since a step names an argument, not an output.
 *
 * Anything else — a template, a primitive, an array, a `dataset` or `input`
 * reference, an instance the row doesn't declare — has nothing inside it.
 */
export function childInputs(
  row: PathRow,
  input: ExecutionInput,
): [string, ExecutionInput][] {
  switch (input.kind) {
    case "value":
      return input.value.kind === "object"
        ? Object.entries(input.value.properties).map(([key, value]) => [
            key,
            { kind: "value", value },
          ])
        : [];
    case "object":
      return Object.entries(input.properties);
    case "instance":
      return Object.entries(row.resources?.[input.name]?.args ?? {});
    default:
      return [];
  }
}

/**
 * The input at a path's root: the field's cell, or a reference to the
 * instance — which the next step then reads the arguments of. `"absent"`
 * when the row has neither.
 */
function rootInput(row: PathRow, path: ColumnPath): ExecutionInput | "absent" {
  if ("field" in path.root) return row.cells[path.root.field] ?? "absent";
  const { instance } = path.root;
  return row.resources && Object.hasOwn(row.resources, instance)
    ? { kind: "instance", name: instance }
    : "absent";
}

/**
 * What `path` reads in `row`, and — when its last step read an instance's
 * argument — which one, so an edit can be sent back there. Each step is
 * taken by {@link childInputs}'s rules; a step that can't be taken reads as
 * `"n/a"`, as does a path that steps through more than
 * {@link MAX_REFERENCE_HOPS} instance references.
 */
export function resolveColumnPath(
  row: PathRow,
  path: ColumnPath,
): ResolvedPath {
  const root = rootInput(row, path);
  if (root === "absent") return { value: root };
  let value: ExecutionInput = root;
  let argument: InstanceArgument | undefined;
  let hops = 0;
  for (const key of path.keys) {
    argument = undefined;
    if (value.kind === "instance") {
      if (++hops > MAX_REFERENCE_HOPS) return { value: "n/a" };
      argument = { instance: value.name, arg: key };
    }
    const next = childInputs(row, value).find(([k]) => k === key);
    if (!next) return { value: "n/a" };
    value = next[1];
  }
  return argument ? { value, argument } : { value };
}

/**
 * What `path` reads in `row`: the input there, `"absent"` when the row has
 * nothing at its root, or `"n/a"` when a step can't be taken. See
 * {@link resolveColumnPath}.
 */
export function readColumnPath(row: PathRow, path: ColumnPath): PathValue {
  return resolveColumnPath(row, path).value;
}

const encodeKey = (key: string) =>
  key.replaceAll("%", "%25").replaceAll("/", "%2F");

/**
 * A path as one string, stable enough to key a column's remembered width by.
 * A field root is its id, an instance root `@name`, and each key `/` plus
 * the key with `/` and `%` percent-encoded — so a field's column is its id,
 * and one of its keys `fieldId/key`, as they were before paths.
 */
export function columnPathId(path: ColumnPath): string {
  const root =
    "field" in path.root ? path.root.field : `@${path.root.instance}`;
  return root + path.keys.map(key => `/${encodeKey(key)}`).join("");
}

/** Whether two paths name the same place. */
export function samePath(a: ColumnPath, b: ColumnPath): boolean {
  return columnPathId(a) === columnPathId(b);
}

/** Thrown by {@link parseColumnPath} for anything that isn't a path. */
export class InvalidColumnPathError extends Error {
  override name = "InvalidColumnPathError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks that `value` is a well-formed {@link ColumnPath} — a root naming a
 * field or an instance by a non-empty string, and `keys` of non-empty
 * strings — and returns it. Whether the root exists is the caller's
 * business.
 *
 * @param at - Where `value` sits, for the error message.
 * @throws {InvalidColumnPathError} naming the first problem found.
 */
export function parseColumnPath(value: unknown, at = "path"): ColumnPath {
  if (!isRecord(value))
    throw new InvalidColumnPathError(`${at} must be an object`);
  const { root, keys } = value;
  if (!isRecord(root)) {
    throw new InvalidColumnPathError(`${at}.root must be an object`);
  }
  let parsedRoot: ColumnPath["root"];
  if (typeof root.field === "string" && root.field !== "") {
    parsedRoot = { field: root.field };
  } else if (typeof root.instance === "string" && root.instance !== "") {
    parsedRoot = { instance: root.instance };
  } else {
    throw new InvalidColumnPathError(
      `${at}.root must be { field } or { instance }, naming it by a non-empty string`,
    );
  }
  if (!Array.isArray(keys)) {
    throw new InvalidColumnPathError(`${at}.keys must be an array`);
  }
  for (const [i, key] of keys.entries()) {
    if (typeof key !== "string" || key === "") {
      throw new InvalidColumnPathError(
        `${at}.keys[${i}] must be a non-empty string`,
      );
    }
  }
  return { root: parsedRoot, keys: [...keys] };
}
