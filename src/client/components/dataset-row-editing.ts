// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Editing a dataset row in the details pane the way the execute panel edits
 * its slots: a field's cell becomes a {@link SlotSelection}, the row's
 * resource instances become the Resources section's state, and both fold back
 * into a row update on commit. Pure. See `specs/datasets.md` §P.2 and
 * `specs/resource-instances.md` §G.
 */

import { committedCell } from "../../shared/dataset-cells";
import { matchKey, samePrompt } from "../../shared/dataset-fields";
import {
  collectInputSlots,
  type InputSlot,
} from "../../shared/input-references";
import type {
  DatasetField,
  DatasetRow,
  DatasetRowUpdate,
  ExecutionInput,
  NormalizedPrompt,
  ResourceInfo,
} from "../../shared/types";
import {
  fromExecutionInput,
  type Selections,
  type SlotSelection,
  toExecutionInput,
} from "./execution-input-state";
import {
  fromWireResources,
  type InstanceSelections,
  toWireResources,
} from "./run-resources-state";

/** The resources a dataset's fields can be filled from, borrowed from prompts. */
export interface DatasetInputSources {
  /** Every resource in scope for the linked prompt or any other loaded one. */
  resources: ResourceInfo[];
  /**
   * Field id → (slot path, rooted at the field's name → URIs that fit it).
   * A field nothing can fill has no entry.
   */
  fieldSlots: Record<string, Record<string, string[]>>;
  /** As `PromptInputSources.resourceSlots`. */
  resourceSlots: Record<string, Record<string, string[]>>;
}

/**
 * The sources that fit a slot of each type, from every slot of every prompt in
 * `prompts` — function and execute parameters, and the arguments of the
 * resources they have in scope — keyed by the slot's type syntax. The provider
 * has already matched sources to those slots by the checker's assignability,
 * so a field whose type reads the same is offered the same ones, wherever the
 * slot it was copied from (if any) lives.
 */
function sourcesByType(
  prompts: readonly NormalizedPrompt[],
): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  const add = (
    slots: readonly InputSlot[],
    matches: Record<string, string[]> | undefined,
  ) => {
    for (const slot of slots) {
      const uris = matches?.[slot.path];
      if (!uris?.length) continue;
      const known = byType.get(slot.type.syntax) ?? [];
      byType.set(slot.type.syntax, [...new Set([...known, ...uris])]);
    }
  };
  for (const {
    functionParameters,
    executeParameters,
    inputSources,
  } of prompts) {
    if (!inputSources) continue;
    add(collectInputSlots(functionParameters), inputSources.functionSlots);
    add(collectInputSlots(executeParameters ?? []), inputSources.executeSlots);
    for (const resource of inputSources.resources) {
      if (!resource.parameters) continue;
      add(
        collectInputSlots(resource.parameters),
        inputSources.resourceSlots?.[resource.uri],
      );
    }
  }
  return byType;
}

/**
 * The resources `prompt` offers, mapped onto `fields`. A field takes a
 * parameter's slots when it matches that parameter by §B's rule (name and
 * type syntax), function parameters first — and since the names are equal,
 * the parameter's slot paths are the field's as they stand. On top of that, a
 * field is offered every source that fits a slot of its type anywhere among
 * `prompts` (see {@link sourcesByType}), so a field added by hand can be filled
 * from the same resources as the slot it resembles. Resources come from all
 * of them too, the linked prompt's first. `undefined` when no prompt has
 * resources at all.
 *
 * @param prompts - Other loaded prompts to borrow slots and resources from.
 *   Only those of the linked prompt's provider are used, when it has one.
 */
export function datasetInputSources(
  fields: readonly DatasetField[],
  prompt: NormalizedPrompt | undefined,
  prompts: readonly NormalizedPrompt[] = [],
): DatasetInputSources | undefined {
  const pool = [
    ...(prompt ? [prompt] : []),
    ...prompts.filter(
      p =>
        !samePrompt(p, prompt) &&
        (!prompt?.providerId || p.providerId === prompt.providerId),
    ),
  ].filter(p => p.inputSources);
  if (pool.length === 0) return undefined;

  const halves = prompt?.inputSources
    ? [
        {
          defs: prompt.functionParameters,
          slots: prompt.inputSources.functionSlots,
        },
        {
          defs: prompt.executeParameters ?? [],
          slots: prompt.inputSources.executeSlots,
        },
      ]
    : [];
  const byType = sourcesByType(pool);
  const fieldSlots: DatasetInputSources["fieldSlots"] = {};
  for (const field of fields) {
    const key = matchKey(field.def);
    const half = halves.find(h => h.defs.some(d => matchKey(d) === key));
    const name = field.def.name;
    const slots: Record<string, string[]> = half
      ? Object.fromEntries(
          Object.entries(half.slots).filter(
            ([path]) => path === name || path.startsWith(`${name}.`),
          ),
        )
      : {};
    for (const slot of collectInputSlots([field.def])) {
      const typed = byType.get(slot.type.syntax);
      if (!typed) continue;
      slots[slot.path] = [...new Set([...(slots[slot.path] ?? []), ...typed])];
    }
    if (Object.keys(slots).length > 0) fieldSlots[field.id] = slots;
  }

  const resources = new Map<string, ResourceInfo>();
  const resourceSlots: DatasetInputSources["resourceSlots"] = {};
  for (const { inputSources } of pool) {
    for (const resource of inputSources?.resources ?? []) {
      if (!resources.has(resource.uri)) resources.set(resource.uri, resource);
    }
    for (const [uri, slots] of Object.entries(
      inputSources?.resourceSlots ?? {},
    )) {
      resourceSlots[uri] ??= slots;
    }
  }
  return { resources: [...resources.values()], fieldSlots, resourceSlots };
}

/** A row's editor state: one selection per field id, and the row's resource instances. */
export interface RowEditorState {
  selections: Selections;
  instances: InstanceSelections;
}

/** The editor state for `row`, as the panel restores its own. */
export function rowEditorState(
  row: Pick<DatasetRow, "cells" | "resources">,
): RowEditorState {
  const selections: Selections = {};
  for (const [fieldId, cell] of Object.entries(row.cells)) {
    selections[fieldId] = fromExecutionInput(cell);
  }
  return { selections, instances: fromWireResources(row.resources) };
}

/**
 * What `state` would change about `row`, of the fields in `fieldIds` and its
 * resource instances: field id → the new cell, or `null` to clear it, and
 * instance name → its new spec, or `null` to remove it. Anything unchanged
 * has no entry, so an untouched row commits nothing.
 */
export function rowChanges(
  fieldIds: readonly string[],
  state: RowEditorState,
  row: Pick<DatasetRow, "cells" | "resources">,
): Omit<DatasetRowUpdate, "rowId"> {
  const cells: Record<string, ExecutionInput | null> = {};
  for (const fieldId of fieldIds) {
    const input = toExecutionInput(state.selections[fieldId]);
    const next =
      input?.kind === "value" ? committedCell(input.value) : (input ?? null);
    if (canonical(next) !== canonical(row.cells[fieldId] ?? null)) {
      cells[fieldId] = next;
    }
  }

  const before = row.resources ?? {};
  const after = toWireResources(state.instances) ?? {};
  const resources: NonNullable<DatasetRowUpdate["resources"]> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const next = after[name] ?? null;
    const { receipt: _, ...prev } = before[name] ?? { uri: "" };
    if (canonical(next) !== canonical(before[name] ? prev : null)) {
      resources[name] = next;
    }
  }
  return {
    cells,
    ...(Object.keys(resources).length > 0 && { resources }),
  };
}

/**
 * A new row with `row`'s cells and resource instances, for
 * `DatasetProvider.addRows`. Its `source` is left behind — a copy is added by
 * hand — and so is any receipt, which a row never carries.
 */
export function duplicateRow(
  row: Pick<DatasetRow, "cells" | "resources">,
): Pick<DatasetRow, "cells" | "resources"> {
  const resources = Object.fromEntries(
    Object.entries(row.resources ?? {}).map(
      ([name, { receipt: _, ...spec }]) => [name, structuredClone(spec)],
    ),
  );
  return {
    cells: structuredClone(row.cells),
    ...(Object.keys(resources).length > 0 && { resources }),
  };
}

/** Whether `changes` changes anything at all. */
export function changesAnything(
  changes: Omit<DatasetRowUpdate, "rowId">,
): boolean {
  return (
    Object.keys(changes.cells).length > 0 ||
    Object.keys(changes.resources ?? {}).length > 0
  );
}

/**
 * Everything in `state` that isn't typed — every source chosen in a slot or
 * an argument, and which instances exist under which names — as one
 * comparable string. A change to it commits at once, since there's nothing
 * more to type; anything else is a draft until blur.
 */
export function chosenResources(state: RowEditorState): string {
  const resourcesOf = (selections: Selections) =>
    Object.fromEntries(
      Object.entries(selections).flatMap(([k, s]: [string, SlotSelection]) =>
        s.resources && Object.keys(s.resources).length > 0
          ? [[k, s.resources]]
          : [],
      ),
    );
  return canonical([
    resourcesOf(state.selections),
    Object.entries(state.instances).map(([name, instance]) => [
      name,
      instance.uri,
      resourcesOf(instance.args),
    ]),
  ]);
}

/** JSON with object keys sorted, so equal inputs compare equal however built. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}
