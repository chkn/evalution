// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type ts from "typescript";
import { MAX_SLOT_DEPTH } from "../../execution-inputs.ts";

/** How many properties one slot tree may contribute, as a runaway guard. */
const MAX_SLOTS = 500;

/**
 * Collect every slot reachable from `roots`, as dotted path → type.
 *
 * Mirrors `collectInputSlots`'s walk over `PropDefinition`s: parameters, plus
 * the object properties nested inside them, to the same {@link MAX_SLOT_DEPTH}
 * — the two must agree, or this side would offer a source at a path the other
 * never produces. Arrays and unions are not descended into: neither has a path
 * that stays meaningful once the value changes shape, so a saved selection
 * could not name one reliably.
 */
export function collectSlotTypes(
  roots: ReadonlyMap<string, ts.Type>,
  typeChecker: ts.TypeChecker,
  location: ts.Node,
): Map<string, ts.Type> {
  const slots = new Map<string, ts.Type>();

  const walk = (prefix: string, type: ts.Type, depth: number) => {
    if (slots.size >= MAX_SLOTS) return;
    slots.set(prefix, type);
    if (depth + 1 >= MAX_SLOT_DEPTH) return;
    if (type.isUnion() || typeChecker.isArrayType(type)) return;
    if (typeChecker.isTupleType(type)) return;

    for (const property of typeChecker.getPropertiesOfType(type)) {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = typeChecker.getTypeOfSymbolAtLocation(
        property,
        declaration ?? location,
      );
      walk(`${prefix}.${property.getName()}`, propertyType, depth + 1);
    }
  };

  for (const [name, type] of roots) walk(name, type, 0);
  return slots;
}

/**
 * Match each source type against each slot by **assignability**.
 *
 * Not by comparing `typeToString` spellings, which is the obvious alternative
 * and is wrong in both directions that matter: `TaskId` and
 * `` `tsk_${string}` `` are one type written two ways, and the AI SDK's own
 * inference produces the template-literal spelling where a prompt's signature
 * uses the alias. Under identity a source would silently fail to be offered on
 * a slot it fits perfectly, and an author's only recourse would be to pin a
 * type argument until the two strings happened to agree.
 *
 * N×M by construction, but each test is a relation check over types the
 * checker has already resolved, not another resolution.
 *
 * @param slots - Slot path → the slot's type, from {@link collectSlotTypes}.
 * @param sources - Source key → the type that source supplies.
 * @param typeChecker - Checker both sets of types were resolved in.
 * @returns Slot path → keys of the sources that fit it.
 */
export function matchByAssignability(
  slots: ReadonlyMap<string, ts.Type>,
  sources: ReadonlyMap<string, ts.Type>,
  typeChecker: ts.TypeChecker,
): Record<string, string[]> {
  const matches: Record<string, string[]> = {};

  for (const [path, slotType] of slots) {
    for (const [key, sourceType] of sources) {
      if (!typeChecker.isTypeAssignableTo(sourceType, slotType)) continue;
      const existing = matches[path];
      if (existing) existing.push(key);
      else matches[path] = [key];
    }
  }

  return matches;
}
