// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Editing a dataset row in the details pane the way the execute panel edits
 * its slots: a field's cell becomes a {@link SlotSelection}, resources and
 * their arguments included, and folds back into a cell on commit. Pure. See
 * `specs/datasets.md` §P.2.
 */

import { committedCell } from "../../shared/dataset-cells";
import { matchKey } from "../../shared/dataset-fields";
import type {
  DatasetField,
  ExecutionInput,
  NormalizedPrompt,
  ResourceInfo,
} from "../../shared/types";
import {
  fromExecutionInput,
  type ResourceArgs,
  resourceArgsFor,
  type Selections,
  toExecutionInput,
} from "./execution-input-state";

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

/** A row's editor state: one selection per field id, and the shared arguments. */
export interface RowEditorState {
  selections: Selections;
  resourceArgs: ResourceArgs;
}

/** The editor state for a row's `cells`, as the panel restores its own. */
export function rowEditorState(
  cells: Record<string, ExecutionInput>,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): RowEditorState {
  const selections: Selections = {};
  const resourceArgs: ResourceArgs = {};
  for (const [fieldId, cell] of Object.entries(cells)) {
    const recovered = fromExecutionInput(cell, resourcesByUri);
    selections[fieldId] = recovered.selection;
    Object.assign(resourceArgs, recovered.resourceArgs);
  }
  return { selections, resourceArgs };
}

/**
 * The cells `state` would change, of the fields in `fieldIds`: field id →
 * the new cell, or `null` to clear it. A field whose cell is unchanged has
 * no entry, so an untouched row commits nothing.
 */
export function rowCellChanges(
  fieldIds: readonly string[],
  state: RowEditorState,
  cells: Record<string, ExecutionInput>,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): Record<string, ExecutionInput | null> {
  const resolveArgs = (uri: string) =>
    resourceArgsFor(uri, state.resourceArgs, resourcesByUri);
  const changes: Record<string, ExecutionInput | null> = {};
  for (const fieldId of fieldIds) {
    const input = toExecutionInput(state.selections[fieldId], resolveArgs);
    const next =
      input?.kind === "value" ? committedCell(input.value) : (input ?? null);
    if (canonical(next) !== canonical(cells[fieldId] ?? null)) {
      changes[fieldId] = next;
    }
  }
  return changes;
}

/** Every resource chosen anywhere in `state`, as one comparable string. */
export function chosenResources(state: RowEditorState): string {
  const resourcesOf = (selections: Selections) =>
    Object.fromEntries(
      Object.entries(selections).map(([k, s]) => [k, s.resources ?? {}]),
    );
  return canonical([
    resourcesOf(state.selections),
    Object.fromEntries(
      Object.entries(state.resourceArgs).map(([uri, args]) => [
        uri,
        resourcesOf(args),
      ]),
    ),
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
