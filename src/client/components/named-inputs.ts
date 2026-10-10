// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The one conversion every dataset flow goes through: **source → named
 * inputs → target**. Four flows move inputs around — panel → row, trace →
 * row, row → panel, and trace → panel ("Open prompt") — and each is a source
 * function here, a target function here, and {@link matchKey} in the middle.
 * Pure; no React. See `specs/datasets.md` §D.
 */

import { stripReceipts } from "../../shared/dataset-cells";
import {
  fieldsForDefs,
  fieldsForPrompt,
  matchKey,
} from "../../shared/dataset-fields";
import { instanceNames } from "../../shared/input-references";
import { jsonToPropValue } from "../../shared/json-prop-value";
import type {
  Dataset,
  DatasetField,
  DatasetRow,
  ExecutionInput,
  NormalizedPrompt,
  PromptID,
  PropDefinition,
  RunResources,
} from "../../shared/types";

/** An input together with the definition that says what it is. */
export interface NamedInput {
  def: PropDefinition;
  input: ExecutionInput;
}

/** Inputs with the definition that says what each one is. */
export type NamedInputs = NamedInput[];

/** Why an input didn't land in its target. */
export type SkipReason =
  /** Nothing in the target has the same name *and* type. */
  | "no-match"
  /** It names a resource the target prompt can't see. */
  | "resource-out-of-scope";

/** An input a target couldn't take, and why — so the UI can say so. */
export interface SkippedInput {
  name: string;
  reason: SkipReason;
}

/**
 * The panel's inputs before they're a request: by slot name, with empty slots
 * simply absent. `collectInputs({ requireAll: false })` produces this.
 */
export interface PartialExecuteRequest {
  functionInputs: Record<string, ExecutionInput>;
  executeInputs: Record<string, ExecutionInput>;
  /** The run's named resource instances, which slots may reference. */
  resources?: RunResources;
}

/**
 * Whether `input` carries nothing — the placeholder a run records for an
 * optional function parameter left empty (`undefined`, which JSON drops).
 */
function isEmpty(input: ExecutionInput | undefined): boolean {
  return (
    !input ||
    (input.kind === "value" &&
      input.value.kind === "primitive" &&
      input.value.value === undefined)
  );
}

function asDefinition(value: unknown): PropDefinition | undefined {
  const def = value as PropDefinition | undefined;
  return def && typeof def.name === "string" && def.type ? def : undefined;
}

// ── sources ──────────────────────────────────────────────────────────────

/** The panel's filled slots, each paired with its parameter's definition. */
export function fromPanel(
  prompt: NormalizedPrompt,
  request: PartialExecuteRequest,
): NamedInputs {
  const out: NamedInputs = [];
  for (const def of prompt.functionParameters) {
    const input = request.functionInputs[def.name];
    if (!isEmpty(input)) out.push({ def, input });
  }
  for (const def of prompt.executeParameters ?? []) {
    const input = request.executeInputs[def.name];
    if (!isEmpty(input)) out.push({ def, input });
  }
  return out;
}

/**
 * A trace's recorded inputs, named and typed.
 *
 * A **playground** trace recorded its unresolved inputs and the definitions
 * they were captured against; the recorded definitions win over `current`'s,
 * since they're the types the inputs actually had (§D.2). `current` fills in
 * only where a trace predates recording a definition.
 *
 * A **production** trace carries only the raw arguments `prompts()` saw —
 * no refs, no types, no names — so names and types come from `current` by
 * position, values go through {@link jsonToPropValue}, and an opaque slot (a
 * live `db`) gets nothing: values only (§D.3). With no `current`, such a
 * trace yields nothing.
 */
export function fromTrace(
  recorded: PromptID,
  current?: NormalizedPrompt,
): NamedInputs {
  const out: NamedInputs = [];

  if (recorded.functionInputs || recorded.executeInputs) {
    (recorded.functionInputs ?? []).forEach((raw, i) => {
      const input = raw as ExecutionInput;
      const def =
        asDefinition(recorded.parameterDefinitions?.[i]) ??
        current?.functionParameters[i];
      if (def && !isEmpty(input)) out.push({ def, input });
    });
    const recordedExec = (recorded.executeParameterDefinitions ?? [])
      .map(asDefinition)
      .filter(d => !!d);
    for (const [name, raw] of Object.entries(recorded.executeInputs ?? {})) {
      const input = raw as ExecutionInput;
      const def =
        recordedExec.find(d => d.name === name) ??
        current?.executeParameters?.find(d => d.name === name);
      if (def && !isEmpty(input)) out.push({ def, input });
    }
    return out;
  }

  if (recorded.functionParameters && current) {
    recorded.functionParameters.forEach((raw, i) => {
      const def = current.functionParameters[i];
      if (!def || raw === undefined || def.type.kind === "opaque") return;
      out.push({ def, input: { kind: "value", value: jsonToPropValue(raw) } });
    });
  }
  return out;
}

/** A row's cells, each paired with its field's definition. */
export function fromRow(dataset: Dataset, row: DatasetRow): NamedInputs {
  return dataset.fields.flatMap(field => {
    const input = row.cells[field.id];
    return input ? [{ def: field.def, input }] : [];
  });
}

/** Whether a trace's root prompt recorded anything {@link fromTrace} can use. */
export function hasRecordedInputs(recorded: PromptID | undefined): boolean {
  return !!(
    recorded &&
    (recorded.functionInputs ||
      recorded.executeInputs ||
      recorded.functionParameters)
  );
}

// ── targets ──────────────────────────────────────────────────────────────

/**
 * Cells for a row of a dataset with `fields`: each input lands in the field
 * that matches it. A cell references the row's resource instances by name;
 * the instances themselves travel beside the cells, as the row's
 * `resources` (receipts stripped — see {@link rowResources}). An input matching no field is skipped;
 * a second input matching an already-filled field is the same value arriving
 * twice (a function and an execute parameter of one name and type) and is
 * neither matched again nor skipped.
 */
export function toCells(
  inputs: NamedInputs,
  fields: readonly DatasetField[],
): {
  cells: Record<string, ExecutionInput>;
  matched: number;
  skipped: SkippedInput[];
} {
  const byKey = new Map(fields.map(f => [matchKey(f.def), f]));
  const cells: Record<string, ExecutionInput> = {};
  const skipped: SkippedInput[] = [];
  let matched = 0;
  for (const { def, input } of inputs) {
    const field = byKey.get(matchKey(def));
    if (!field) {
      skipped.push({ name: def.name, reason: "no-match" });
      continue;
    }
    if (field.id in cells) continue;
    cells[field.id] = input;
    matched++;
  }
  return { cells, matched, skipped };
}

/**
 * The resource instances a dataset row keeps: `resources` without receipts,
 * or `undefined` when there are none. A receipt makes a run reconstruct a
 * *past* instance; a row is a recipe for new runs.
 */
export function rowResources(
  resources: RunResources | undefined,
): RunResources | undefined {
  return resources && Object.keys(resources).length > 0
    ? stripReceipts(resources)
    : undefined;
}

/**
 * Panel inputs for `prompt`: each input fills every slot it matches — a
 * function and an execute parameter of one name and type are one value, so
 * both get it. `resources` come along, receipts stripped, except an instance
 * of a resource outside this prompt's `inputSources`: it couldn't be created
 * here, so it's dropped — with every instance whose arguments name it — and
 * an input referencing a dropped one is skipped rather than filled; it would
 * only fail at Run.
 */
export function toPanel(
  inputs: NamedInputs,
  prompt: NormalizedPrompt,
  resources?: RunResources,
): PartialExecuteRequest & { skipped: SkippedInput[] } {
  const inScope = new Set(
    (prompt.inputSources?.resources ?? []).map(r => r.uri),
  );
  const kept: RunResources = {};
  const dropped = new Set<string>();
  for (const [name, spec] of Object.entries(rowResources(resources) ?? {})) {
    if (inScope.has(spec.uri)) kept[name] = spec;
    else dropped.add(name);
  }
  // An instance whose arguments name a dropped one couldn't be created
  // either: drop it too, and whatever names it in turn.
  for (let changed = dropped.size > 0; changed; ) {
    changed = false;
    for (const [name, spec] of Object.entries(kept)) {
      const args = Object.values(spec.args ?? {});
      if (args.some(arg => instanceNames(arg).some(n => dropped.has(n)))) {
        delete kept[name];
        dropped.add(name);
        changed = true;
      }
    }
  }
  const functionInputs: Record<string, ExecutionInput> = {};
  const executeInputs: Record<string, ExecutionInput> = {};
  const skipped: SkippedInput[] = [];

  for (const { def, input } of inputs) {
    const key = matchKey(def);
    const fnDef = prompt.functionParameters.find(d => matchKey(d) === key);
    const execDef = prompt.executeParameters?.find(d => matchKey(d) === key);
    if (!fnDef && !execDef) {
      skipped.push({ name: def.name, reason: "no-match" });
      continue;
    }
    if (instanceNames(input).some(name => dropped.has(name))) {
      skipped.push({ name: def.name, reason: "resource-out-of-scope" });
      continue;
    }
    if (fnDef) functionInputs[fnDef.name] = input;
    if (execDef) executeInputs[execDef.name] = input;
  }
  return {
    functionInputs,
    executeInputs,
    ...(Object.keys(kept).length > 0 && { resources: kept }),
    skipped,
  };
}

/** A schema for "New dataset" from a set of inputs: one field per distinct input. */
function fieldsFor(inputs: NamedInputs): Omit<DatasetField, "id">[] {
  return fieldsForDefs(inputs.map(i => i.def));
}

/**
 * A schema for "New dataset" from a trace: the recorded definitions when it
 * has them (the types its inputs were captured against), else `current`'s
 * signature, else just the inputs themselves.
 */
export function fieldsForTrace(
  recorded: PromptID,
  current: NormalizedPrompt | undefined,
  inputs: NamedInputs,
): Omit<DatasetField, "id">[] {
  const recordedDefs = [
    ...(recorded.parameterDefinitions ?? []),
    ...(recorded.executeParameterDefinitions ?? []),
  ]
    .map(asDefinition)
    .filter(d => !!d);
  if (recordedDefs.length > 0) return fieldsForDefs(recordedDefs);
  if (current) return fieldsForPrompt(current);
  return fieldsFor(inputs);
}

/**
 * How many of `inputs` would land in a dataset with `fields` — what the
 * add-to-dataset menu shows beside each dataset ("3 of 4 fields").
 */
export function countMatches(
  inputs: NamedInputs,
  fields: readonly DatasetField[],
): number {
  return toCells(inputs, fields).matched;
}

/**
 * Fields of `dataset` that no longer match any of `prompt`'s parameters —
 * the "N fields no longer match" line above a linked dataset's table. Fields
 * added by hand never came from the prompt, so they're never stale.
 */
export function staleFields(
  fields: readonly DatasetField[],
  prompt: NormalizedPrompt,
): DatasetField[] {
  const keys = new Set(
    [...prompt.functionParameters, ...(prompt.executeParameters ?? [])].map(
      matchKey,
    ),
  );
  return fields.filter(f => !f.added && !keys.has(matchKey(f.def)));
}

// ── filling the panel from outside ───────────────────────────────────────

/**
 * Where a {@link PanelFill} came from — enough to name it in the notice and
 * to open it again. Plain data rather than a callback: by the time the link
 * is clicked, the tab and pane that made the fill may be long gone.
 */
export type PanelFillSource = { description: string } & (
  | { type: "trace"; providerId: string; traceId: string }
  | { type: "dataset"; providerId: string; datasetId: string; name: string }
);

/**
 * A one-shot request to overwrite the execute panel, carried on a prompt tab
 * — from a trace ("Open prompt") or a dataset row ("Open in playground").
 * Matched slots are overwritten; every other slot keeps what it had.
 */
export interface PanelFill {
  functionInputs: Record<string, ExecutionInput>;
  executeInputs: Record<string, ExecutionInput>;
  /** Resource instances the inputs reference, receipts stripped. */
  resources?: RunResources;
  /** Shown in the notice: "trace 3f2a1b2c…" / "Support tickets, row 4". */
  from: PanelFillSource;
  /** What didn't fit, named in the notice. */
  skipped: SkippedInput[];
  /** Distinguishes one fill from the next, so each applies exactly once. */
  nonce: number;
}

let fillSeq = 0;

/**
 * A {@link PanelFill} for `prompt` from `inputs` and the resource instances
 * they came with — a row's, or a trace's recorded ones — with a fresh nonce.
 */
export function panelFill(
  inputs: NamedInputs,
  prompt: NormalizedPrompt,
  from: PanelFillSource,
  resources?: RunResources,
): PanelFill {
  const { functionInputs, executeInputs, skipped, ...rest } = toPanel(
    inputs,
    prompt,
    resources,
  );
  // Time-based as well as sequential, so a nonce minted after a reload never
  // collides with one an earlier page load already applied.
  return {
    functionInputs,
    executeInputs,
    ...(rest.resources && { resources: rest.resources }),
    from,
    skipped,
    nonce: Date.now() * 1000 + (fillSeq++ % 1000),
  };
}
