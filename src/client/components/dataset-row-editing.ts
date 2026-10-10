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
import { matchKey } from "../../shared/dataset-fields";
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

/** The resources a dataset's fields can be filled from, borrowed from a prompt. */
export interface DatasetInputSources {
  /** Every resource in the prompt's scope. */
  resources: ResourceInfo[];
  /**
   * Field id → (slot path, rooted at the field's name → URIs that fit it).
   * A field that matches no parameter has no entry.
   */
  fieldSlots: Record<string, Record<string, string[]>>;
  /** As `PromptInputSources.resourceSlots`. */
  resourceSlots: Record<string, Record<string, string[]>>;
}

/**
 * The resources `prompt` offers, mapped onto `fields`. A field takes a
 * parameter's slots when it matches that parameter by §B's rule (name and
 * type syntax), function parameters first — and since the names are equal,
 * the parameter's slot paths are the field's as they stand. `undefined`
 * without a prompt, or when the prompt has no resources at all.
 */
export function datasetInputSources(
  fields: readonly DatasetField[],
  prompt: NormalizedPrompt | undefined,
): DatasetInputSources | undefined {
  const sources = prompt?.inputSources;
  if (!prompt || !sources) return undefined;

  const halves = [
    { defs: prompt.functionParameters, slots: sources.functionSlots },
    { defs: prompt.executeParameters ?? [], slots: sources.executeSlots },
  ];
  const fieldSlots: DatasetInputSources["fieldSlots"] = {};
  for (const field of fields) {
    const key = matchKey(field.def);
    const half = halves.find(h => h.defs.some(d => matchKey(d) === key));
    if (!half) continue;
    const name = field.def.name;
    const own = Object.fromEntries(
      Object.entries(half.slots).filter(
        ([path]) => path === name || path.startsWith(`${name}.`),
      ),
    );
    if (Object.keys(own).length > 0) fieldSlots[field.id] = own;
  }

  return {
    resources: sources.resources,
    fieldSlots,
    resourceSlots: sources.resourceSlots ?? {},
  };
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
