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
import type { ExecutionInput, PropType, PropValue } from "./types.ts";

/**
 * `input` without any resource receipt, at any depth.
 *
 * A receipt makes `create` reconstruct a *past* run's identity; a dataset row
 * is a recipe for new runs, so two rows keeping the same receipt would
 * collide on the id it names the moment the dataset is run.
 */
export function stripReceipts(input: ExecutionInput): ExecutionInput {
  switch (input.kind) {
    case "resource": {
      const { receipt: _receipt, args, ...rest } = input;
      return args
        ? {
            ...rest,
            args: Object.fromEntries(
              Object.entries(args).map(([k, v]) => [k, stripReceipts(v)]),
            ),
          }
        : rest;
    }
    case "object":
      return {
        kind: "object",
        properties: Object.fromEntries(
          Object.entries(input.properties).map(([k, v]) => [
            k,
            stripReceipts(v),
          ]),
        ),
      };
    default:
      return input;
  }
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
 * may hold, and returns it with receipts removed.
 *
 * The check is structural: `value` must be one of the `value`, `object`, or
 * `resource` variants, recursively. The `dataset` variant is refused — a row
 * holds copies, not references to other rows. A `value`'s `PropValue` is only
 * checked for being an object with a `kind`; its full shape is the editor's
 * business, and it round-trips as JSON either way.
 *
 * @param path - Where `value` sits, for the error message.
 * @throws {InvalidCellError} naming the first problem found.
 */
export function parseCell(value: unknown, path = "cell"): ExecutionInput {
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
            parseCell(v, `${path}.properties.${k}`),
          ]),
        ),
      };
    }
    case "resource": {
      if (typeof value.uri !== "string" || value.uri === "") {
        throw new InvalidCellError(`${path}.uri must be a non-empty string`);
      }
      if (value.args !== undefined && !isRecord(value.args)) {
        throw new InvalidCellError(`${path}.args must be an object`);
      }
      const args = value.args as Record<string, unknown> | undefined;
      return {
        kind: "resource",
        uri: value.uri,
        ...(args && {
          args: Object.fromEntries(
            Object.entries(args).map(([k, v]) => [
              k,
              parseCell(v, `${path}.args.${k}`),
            ]),
          ),
        }),
      };
    }
    case "dataset":
      throw new InvalidCellError(
        `${path} is a dataset reference; a dataset cell must hold a value, object, or resource`,
      );
    default:
      throw new InvalidCellError(
        `${path}.kind must be "value", "object", or "resource"`,
      );
  }
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
