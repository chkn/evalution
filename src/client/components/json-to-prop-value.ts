// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropValue } from "ts-proppy";

/**
 * Converts a plain JSON value into the `PropValue` shape ts-proppy's editors
 * expect, so a resource's server-sent value preview ({@link ResourceInfo.value})
 * can be rendered through the same editor a slot's own value would use.
 *
 * Only ever fed a value the server already proved is plain JSON data (see
 * `isPlainSerializable` in `resource-registry.ts`, which is what decides
 * whether {@link ResourceInfo.value} is present at all) — there is no
 * `template`, `functionCall`, or other authored-source `PropValue` kind to
 * produce here, only the data kinds a plain value can be.
 */
export function jsonToPropValue(value: unknown): PropValue {
  if (Array.isArray(value)) {
    return { kind: "array", elements: value.map(jsonToPropValue) };
  }
  if (value !== null && typeof value === "object") {
    return {
      kind: "object",
      properties: Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, jsonToPropValue(v)]),
      ),
    };
  }
  return {
    kind: "primitive",
    value: value as string | number | boolean | null,
  };
}
