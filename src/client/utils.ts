// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { getSelectableUnionInfo } from "ts-proppy/react";
import type { PropDefinition, PropValue } from "../shared/types";

/**
 * Returns `set` with `value`'s membership set to `present`, or `set` itself
 * unchanged when membership already matches. Callers that feed the result
 * into `setState` rely on getting back the same reference for a no-op change
 * so React can bail out of the update — otherwise a state setter invoked
 * every render (e.g. from a prop callback recreated each render) never
 * settles.
 */
export function withSetMembership<T>(
  set: Set<T>,
  value: T,
  present: boolean,
): Set<T> {
  if (present === set.has(value)) return set;
  const next = new Set(set);
  present ? next.add(value) : next.delete(value);
  return next;
}

export function encodePromptId(id: string): string {
  return btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Returns a prompt's provider ID, which the server always populates. Logs a
 * warning and falls back to `''` if it's somehow missing, so the failure is
 * visible rather than silent (an empty provider ID won't match any prompt).
 */
export function requireProviderId(
  providerId: string | undefined,
  context: string,
): string {
  if (!providerId) {
    console.warn(
      `[evalution] Missing providerId for ${context}; prompt linking may not work.`,
    );
    return "";
  }
  return providerId;
}

/**
 * Returns a sensible initial {@link PropValue} for a parameter type when no
 * explicit `defaultValue` is available (e.g. parameters extracted from SDK
 * type declarations that carry only type information).
 */
export function defaultValueForType(type: PropDefinition["type"]): PropValue {
  if (type.kind === "primitive") {
    if (type.syntax === "number") return { kind: "primitive", value: 0 };
    if (type.syntax === "boolean") return { kind: "primitive", value: false };
    return { kind: "primitive", value: "" };
  }
  if (type.kind === "array") return { kind: "array", elements: [] };
  if (type.kind === "union") {
    // A union with an open-ended member (`string | null`, `'auto' | number`)
    // opens on that member's editor, so seed its default rather than a
    // constant the user would have to clear.
    const selectable = getSelectableUnionInfo(type);
    if (selectable)
      return defaultValueForType(selectable.members[selectable.defaultIndex]);
    // Otherwise every member is a constant, and the first is the dropdown's
    // initial selection.
    const constant = type.types.find(t => t.kind === "constant");
    if (constant && constant.kind === "constant")
      return { kind: "primitive", value: constant.value };
  }
  return { kind: "primitive", value: undefined };
}
