// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What may be stored in a dataset cell, shared by the client (which strips
 * receipts before sending) and the server (which checks everything before
 * storing). Pure — no runtime dependencies. See `specs/datasets.md` §A, §F.
 */

import {
  isPrimitiveFieldType,
  type PrimitiveFieldType,
} from "./dataset-fields.ts";
import { isValidInstanceName } from "./instance-names.ts";
import type {
  ExecutionInput,
  PropType,
  PropValue,
  RunResources,
} from "./types.ts";

/**
 * `resources` without any receipt.
 *
 * A receipt makes `create` reconstruct a *past* run's identity; a dataset row
 * is a recipe for new runs, so two rows keeping the same receipt would
 * collide on the id it names the moment the dataset is run.
 */
export function stripReceipts(resources: RunResources): RunResources {
  return Object.fromEntries(
    Object.entries(resources).map(([name, { receipt: _receipt, ...spec }]) => [
      name,
      spec,
    ]),
  );
}

/** Thrown by {@link parseCell} for anything that isn't a storable cell. */
export class InvalidCellError extends Error {
  override name = "InvalidCellError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks that `value` is a well-formed {@link ExecutionInput} a dataset cell
 * may hold, and returns it.
 *
 * The check is structural: `value` must be one of the `value`, `object`,
 * `instance` or `input` variants, recursively. The `dataset` variant is refused — a row
 * holds copies, not references to other rows. A `value`'s `PropValue` is only
 * checked for being an object with a `kind`; its full shape is the editor's
 * business, and it round-trips as JSON either way.
 *
 * @param path - Where `value` sits, for the error message.
 * @throws {InvalidCellError} naming the first problem found.
 */
export function parseCell(value: unknown, path = "cell"): ExecutionInput {
  return parseInput(value, path, false);
}

/**
 * {@link parseCell} for an eval's bindings, which may also name a column of
 * the row being run (`{ kind: "dataset", field }`), anywhere a cell's
 * contents may sit. See `specs/evals.md` §B.2.
 *
 * @param path - Where `value` sits, for the error message.
 * @throws {InvalidCellError} naming the first problem found.
 */
export function parseBinding(value: unknown, path = "binding"): ExecutionInput {
  return parseInput(value, path, true);
}

function parseInput(
  value: unknown,
  path: string,
  columns: boolean,
): ExecutionInput {
  const recurse = (v: unknown, p: string) => parseInput(v, p, columns);
  if (!isRecord(value)) {
    throw new InvalidCellError(`${path} must be an object`);
  }
  switch (value.kind) {
    case "value":
      if (!isRecord(value.value) || typeof value.value.kind !== "string") {
        throw new InvalidCellError(`${path}.value must be a PropValue`);
      }
      return { kind: "value", value: value.value as any };
    case "object": {
      if (!isRecord(value.properties)) {
        throw new InvalidCellError(`${path}.properties must be an object`);
      }
      return {
        kind: "object",
        properties: Object.fromEntries(
          Object.entries(value.properties).map(([k, v]) => [
            k,
            recurse(v, `${path}.properties.${k}`),
          ]),
        ),
      };
    }
    case "instance": {
      if (typeof value.name !== "string" || value.name === "") {
        throw new InvalidCellError(`${path}.name must be a non-empty string`);
      }
      if (value.output !== undefined && typeof value.output !== "string") {
        throw new InvalidCellError(`${path}.output must be a string`);
      }
      return {
        kind: "instance",
        name: value.name,
        ...(value.output !== undefined && { output: value.output }),
      };
    }
    case "input": {
      // A row captured from the panel keeps an `input` recipe as-is: slot
      // paths are the prompt's own, so it means the same wherever the row
      // is run (`specs/evals.md` §B.2.1).
      if (value.half !== "function" && value.half !== "execute") {
        throw new InvalidCellError(
          `${path}.half must be "function" or "execute"`,
        );
      }
      if (typeof value.path !== "string" || value.path === "") {
        throw new InvalidCellError(`${path}.path must be a non-empty string`);
      }
      return { kind: "input", half: value.half, path: value.path };
    }
    case "dataset":
      if (columns) {
        if (typeof value.field !== "string" || value.field === "") {
          throw new InvalidCellError(
            `${path}.field must be a non-empty string`,
          );
        }
        return { kind: "dataset", field: value.field };
      }
      throw new InvalidCellError(
        `${path} is a column reference; a dataset cell must hold a value, object, resource, or slot reference`,
      );
    default:
      throw new InvalidCellError(
        `${path}.kind must be "value", "object", "instance", or "input"`,
      );
  }
}

/**
 * Checks that `value` is a well-formed {@link RunResources} map — a dataset
 * row's, or an eval's — and returns it with receipts removed. Each
 * instance's `args` are checked as {@link parseCell} checks a cell, or, with
 * `columns`, as {@link parseBinding} does. Names are checked for shape only;
 * whether the `uri` names a real resource is the provider's business at run
 * time. See `specs/resource-instances.md` §C.
 *
 * @param columns - Whether arguments may name a column of the row being run.
 * @param path - Where `value` sits, for the error message.
 * @throws {InvalidCellError} naming the first problem found.
 */
export function parseResources(
  value: unknown,
  {
    columns = false,
    path = "resources",
  }: { columns?: boolean; path?: string } = {},
): RunResources {
  if (!isRecord(value)) {
    throw new InvalidCellError(`${path} must be an object`);
  }
  const out: RunResources = {};
  for (const [name, spec] of Object.entries(value)) {
    const at = `${path}.${name}`;
    if (!isValidInstanceName(name)) {
      throw new InvalidCellError(
        `${at}: a resource name uses letters, digits, '_' and '-', not starting with a digit or '-'`,
      );
    }
    if (!isRecord(spec)) throw new InvalidCellError(`${at} must be an object`);
    if (typeof spec.uri !== "string" || spec.uri === "") {
      throw new InvalidCellError(`${at}.uri must be a non-empty string`);
    }
    if (spec.args !== undefined && !isRecord(spec.args)) {
      throw new InvalidCellError(`${at}.args must be an object`);
    }
    const args = spec.args as Record<string, unknown> | undefined;
    out[name] = {
      uri: spec.uri,
      ...(args && {
        args: Object.fromEntries(
          Object.entries(args).map(([k, v]) => [
            k,
            parseInput(v, `${at}.args.${k}`, columns),
          ]),
        ),
      }),
    };
  }
  return out;
}

/**
 * The cell an editor's value commits as: a typed-in value, or `null` — clear
 * the cell — when the editor was emptied (`undefined`, `null`, or `""`), so a
 * cleared cell has no key, whether it was cleared in the grid or the details
 * pane.
 */
export function committedCell(value: PropValue): ExecutionInput | null {
  if (
    value.kind === "primitive" &&
    (value.value === undefined || value.value === null || value.value === "")
  ) {
    return null;
  }
  return { kind: "value", value };
}

/**
 * The primitive types a dataset cell can be typed straight into — the same
 * ones a field can be given by hand.
 */
export type EditableBase = PrimitiveFieldType;

/**
 * The base of a field typed `string`, `number`, or `boolean`, or `undefined`
 * for any other type. Read from `base` when the checker recorded one, and
 * otherwise from the syntax, which for a bare primitive is the same thing.
 */
export function primitiveBase(type: PropType): EditableBase | undefined {
  if (type.kind !== "primitive") return undefined;
  const base = type.base ?? type.syntax;
  return isPrimitiveFieldType(base) ? base : undefined;
}

/**
 * Whether `value` is something a field of primitive type `base` may hold as
 * a typed-in value: a primitive of that type, or — for a string — a template,
 * which is how a string with interpolations is stored. See
 * `specs/datasets.md` §P.2.
 */
export function fitsPrimitiveBase(
  value: PropValue,
  base: EditableBase,
): boolean {
  if (value.kind === "primitive") return typeof value.value === base;
  return base === "string" && value.kind === "template";
}
