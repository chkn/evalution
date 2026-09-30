// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Columns and prompt slots as sources: `ResourceInfo` entries with URIs the
 * server never sees, grouped as **Columns** and **Prompt inputs**, so the
 * existing picker, chips and slot matching offer them without knowing they
 * aren't resources. `toExecutionInput` turns a chosen one into the `dataset`
 * or `input` variant it stands for. See `specs/evals.md` §B.2 and §F.
 */

import type { DatasetField } from "../../dataset/dataset-types";
import {
  collectInputSlots,
  findInputCycle,
  type InputBindings,
} from "../../shared/input-references";
import type {
  ExecutionInput,
  PromptInputSources,
  PropDefinition,
  PropType,
  ResourceInfo,
} from "../../shared/types";

const COLUMN_PREFIX = "@@column/";
const INPUT_PREFIX = "@@input/";

/** The picker entry that adds a dataset column from the slot it's chosen for. */
export const NEW_COLUMN_URI = "@@new-column";

/** The group columns are listed under. */
export const COLUMNS_GROUP = "Columns";
/** The group other prompt slots are listed under. */
export const PROMPT_INPUTS_GROUP = "Prompt inputs";

/** The pseudo-source URI for dataset field `field`. */
export function columnUri(field: string): string {
  return `${COLUMN_PREFIX}${field}`;
}

/** The pseudo-source URI for the prompt slot `path` in `half`. */
export function inputUri(half: "function" | "execute", path: string): string {
  return `${INPUT_PREFIX}${half}/${path}`;
}

/** Whether `uri` names a pseudo-source rather than a resource. */
export function isPseudoUri(uri: string): boolean {
  return uri.startsWith("@@");
}

/**
 * The input a pseudo-source URI stands for, or `undefined` for a real
 * resource (and for {@link NEW_COLUMN_URI}, which stands for nothing yet).
 */
export function pseudoInput(uri: string): ExecutionInput | undefined {
  if (uri.startsWith(COLUMN_PREFIX)) {
    return { kind: "dataset", field: uri.slice(COLUMN_PREFIX.length) };
  }
  if (uri.startsWith(INPUT_PREFIX)) {
    const rest = uri.slice(INPUT_PREFIX.length);
    const slash = rest.indexOf("/");
    const half = rest.slice(0, slash);
    if (half !== "function" && half !== "execute") return undefined;
    return { kind: "input", half, path: rest.slice(slash + 1) };
  }
  return undefined;
}

/** The pseudo-source URI a `dataset` or `input` node is chosen as. */
export function pseudoUriOf(input: ExecutionInput): string | undefined {
  if (input.kind === "dataset") return columnUri(input.field);
  if (input.kind === "input") return inputUri(input.half, input.path);
  return undefined;
}

/** How an `input` reference reads: `taskId`, or `execute.db` for an execute slot. */
export function slotLabel(half: "function" | "execute", path: string): string {
  return half === "execute" ? `execute.${path}` : path;
}

/**
 * Whether a value of type `from` can fill a slot of type `to`, loosely: the
 * same syntax, or primitives with the same base. Loose on purpose — `string`
 * into a branded `TaskId` is a mismatch the schema will accept.
 */
export function typesFit(from: PropType, to: PropType): boolean {
  if (from.syntax === to.syntax) return true;
  return (
    from.kind === "primitive" &&
    to.kind === "primitive" &&
    from.base === to.base
  );
}

/** One slot `input` references can target. */
interface Target {
  half: "function" | "execute";
  path: string;
  type: PropType;
}

/** Whether one dotted path is the other, or contains it. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/** `bindings`, with slot `path` in `half` bound to `ref` instead. */
function withRefAt(
  bindings: InputBindings,
  half: "function" | "execute",
  path: string,
  ref: ExecutionInput,
): InputBindings {
  const [root, ...rest] = path.split(".");
  const place = (node: ExecutionInput | undefined, segs: string[]) => {
    if (segs.length === 0) return ref;
    const [head, ...tail] = segs;
    const properties = node?.kind === "object" ? { ...node.properties } : {};
    properties[head!] = place(properties[head!], tail);
    return { kind: "object", properties } as ExecutionInput;
  };
  const key = half === "function" ? "functionInputs" : "executeInputs";
  return {
    ...bindings,
    [key]: { ...bindings[key], [root!]: place(bindings[key][root!], rest) },
  };
}

/** Options for {@link withPseudoSources}. */
export interface PseudoSourceOptions {
  /** The prompt's signature, for the **Prompt inputs** group. */
  functionParameters: readonly PropDefinition[];
  executeParameters?: readonly PropDefinition[];
  /**
   * The slots' current bindings, so a slot is never offered where picking
   * it would close a cycle. See `specs/evals.md` §B.2.1.
   */
  bindings: InputBindings;
  /** The dataset's fields, for the **Columns** group. Absent in the panel. */
  fields?: readonly Pick<DatasetField, "id" | "def">[];
  /**
   * Offer every column and slot, whether or not its type fits — the eval
   * editor, where the chip then warns of a mismatch. By default only
   * fitting slots are offered — the panel.
   */
  offerMismatches?: boolean;
  /** Offer "＋ New column from this slot" on the prompt's own slots. */
  newColumn?: boolean;
}

/** Every slot of the prompt an `input` reference can name. */
function targetsOf(options: PseudoSourceOptions): Target[] {
  return [
    ...collectInputSlots(options.functionParameters).map(s => ({
      half: "function" as const,
      path: s.path,
      type: s.type,
    })),
    ...collectInputSlots(options.executeParameters ?? []).map(s => ({
      half: "execute" as const,
      path: s.path,
      type: s.type,
    })),
  ];
}

/** The pseudo-source entries for `fields` and `targets`, as the picker lists them. */
function pseudoResources(
  fields: readonly Pick<DatasetField, "id" | "def">[],
  targets: readonly Target[],
  newColumnLabel?: string,
): ResourceInfo[] {
  return [
    ...fields.map(
      (f): ResourceInfo => ({
        uri: columnUri(f.id),
        label: f.def.name,
        scope: "run",
        group: [COLUMNS_GROUP],
      }),
    ),
    ...(newColumnLabel
      ? [
          {
            uri: NEW_COLUMN_URI,
            label: newColumnLabel,
            scope: "run",
            group: [COLUMNS_GROUP],
          } satisfies ResourceInfo,
        ]
      : []),
    ...targets.map(
      (t): ResourceInfo => ({
        uri: inputUri(t.half, t.path),
        label: `= ${slotLabel(t.half, t.path)}`,
        scope: "run",
        group: [PROMPT_INPUTS_GROUP],
      }),
    ),
  ];
}

/**
 * `sources`, with columns and other prompt slots added as sources for every
 * slot — and every resource argument, so `seededTask`'s `title` can take a
 * column too.
 */
export function withPseudoSources(
  sources: PromptInputSources | undefined,
  options: PseudoSourceOptions,
): PromptInputSources {
  const targets = targetsOf(options);
  const fields = options.fields ?? [];

  /** The pseudo-sources to offer a slot of `type` at `self`. */
  const offer = (type: PropType, self?: Omit<Target, "type">): string[] => {
    const uris: string[] = [];
    for (const field of fields) {
      if (options.offerMismatches || typesFit(field.def.type, type)) {
        uris.push(columnUri(field.id));
      }
    }
    for (const target of targets) {
      if (
        self &&
        target.half === self.half &&
        overlaps(target.path, self.path)
      ) {
        continue;
      }
      if (!options.offerMismatches && !typesFit(target.type, type)) continue;
      if (self) {
        const ref: ExecutionInput = {
          kind: "input",
          half: target.half,
          path: target.path,
        };
        const tried = withRefAt(options.bindings, self.half, self.path, ref);
        if (findInputCycle(tried)) continue;
      }
      uris.push(inputUri(target.half, target.path));
    }
    return uris;
  };

  const slotsFor = (
    half: "function" | "execute",
    existing: Record<string, string[]> | undefined,
  ) => {
    const out: Record<string, string[]> = { ...existing };
    for (const target of targets.filter(t => t.half === half)) {
      const offered = offer(target.type, target);
      if (options.newColumn) offered.push(NEW_COLUMN_URI);
      if (offered.length > 0) {
        out[target.path] = [...(out[target.path] ?? []), ...offered];
      }
    }
    return out;
  };

  const resourceSlots: Record<string, Record<string, string[]>> = {
    ...sources?.resourceSlots,
  };
  for (const resource of sources?.resources ?? []) {
    if (!resource.parameters?.length) continue;
    const slots: Record<string, string[]> = {
      ...sources?.resourceSlots?.[resource.uri],
    };
    for (const slot of collectInputSlots(resource.parameters)) {
      const offered = offer(slot.type);
      if (offered.length > 0) {
        slots[slot.path] = [...(slots[slot.path] ?? []), ...offered];
      }
    }
    resourceSlots[resource.uri] = slots;
  }

  return {
    resources: [
      ...(sources?.resources ?? []),
      ...pseudoResources(
        fields,
        targets,
        options.newColumn ? "＋ New column from this slot" : undefined,
      ),
    ],
    functionSlots: slotsFor("function", sources?.functionSlots),
    executeSlots: slotsFor("execute", sources?.executeSlots),
    resourceSlots,
  };
}

/**
 * Sources for a check's parameters in the eval editor, as the `slots` an
 * `ExecutionInputEditor` takes (rooted at each parameter's name): every
 * column and prompt slot, plus "＋ New column". Nothing references a check's
 * parameters, so no choice here can close a cycle.
 */
export function checkParameterSources(
  parameters: readonly PropDefinition[],
  options: Pick<
    PseudoSourceOptions,
    "functionParameters" | "executeParameters" | "fields"
  >,
): PromptInputSources {
  const targets = targetsOf({ ...options, bindings: emptyBindings() });
  const resources = pseudoResources(
    options.fields ?? [],
    targets,
    "＋ New column from this parameter",
  );
  const uris = resources.map(r => r.uri);
  return {
    resources,
    functionSlots: Object.fromEntries(
      collectInputSlots(parameters).map(slot => [slot.path, uris]),
    ),
    executeSlots: {},
  };
}

/** No bindings at all. */
export function emptyBindings(): InputBindings {
  return { functionInputs: {}, executeInputs: {} };
}

/**
 * What a chip for pseudo-source `uri` says beneath its label, and whether it
 * warns that the source's type doesn't fit the slot's.
 */
export function describePseudoSource(
  uri: string,
  slotType: PropType,
  options: Pick<
    PseudoSourceOptions,
    "functionParameters" | "executeParameters" | "fields"
  >,
): { note: string; warning?: string } | undefined {
  const input = pseudoInput(uri);
  if (!input) return undefined;
  let type: PropType | undefined;
  let note = "";
  if (input.kind === "dataset") {
    type = options.fields?.find(f => f.id === input.field)?.def.type;
    note = type ? "column of each row" : "column no longer exists";
  } else if (input.kind === "input") {
    const { half, path } = input;
    type = targetsOf({ ...options, bindings: emptyBindings() }).find(
      t => t.half === half && t.path === path,
    )?.type;
    note = type ? "same value as that input" : "input no longer exists";
  }
  return type && !typesFit(type, slotType)
    ? { note, warning: `${type.syntax} into ${slotType.syntax}` }
    : { note };
}
