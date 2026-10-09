// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Columns, prompt slots and the run's resource instances as sources:
 * `ResourceInfo` entries with URIs the server never sees, grouped as
 * **Columns**, **Prompt inputs** and **Resources in this run**, so the
 * existing picker, chips and slot matching offer them without knowing they
 * aren't resources. `toExecutionInput` turns a chosen one into the
 * `dataset`, `input` or `instance` variant it stands for. See
 * `specs/evals.md` §B.2 and §F, and `specs/resource-instances.md` §G.
 */

import type { DatasetField } from "../../dataset/dataset-types";
import {
  collectInputSlots,
  findInputCycle,
  type InputBindings,
  overlaps,
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
const INSTANCE_PREFIX = "@@instance/";

/** The picker entry that adds a dataset column from the slot it's chosen for. */
export const NEW_COLUMN_URI = "@@new-column";

/** The group columns are listed under. */
export const COLUMNS_GROUP = "Dataset columns";
/** The group other prompt slots are listed under. */
export const PROMPT_INPUTS_GROUP = "Prompt inputs";
/** The group the run's own resource instances are listed under, first. */
export const INSTANCES_GROUP = "Resources in this run";
/** The group the resource catalog moves under once the run has instances to list first. */
export const NEW_GROUP = "New";

/** The pseudo-source URI for dataset field `field`. */
export function columnUri(field: string): string {
  return `${COLUMN_PREFIX}${field}`;
}

/** The pseudo-source URI for the prompt slot `path` in `half`. */
export function inputUri(half: "function" | "execute", path: string): string {
  return `${INPUT_PREFIX}${half}/${path}`;
}

/** The pseudo-source URI for the run's instance `name`, or its `output`. */
export function instanceUri(name: string, output?: string): string {
  return output === undefined
    ? `${INSTANCE_PREFIX}${name}`
    : `${INSTANCE_PREFIX}${name}/${output}`;
}

/** The instance (and output) an {@link instanceUri} names, or `undefined` for any other URI. */
export function parseInstanceUri(
  uri: string,
): { name: string; output?: string } | undefined {
  if (!uri.startsWith(INSTANCE_PREFIX)) return undefined;
  const rest = uri.slice(INSTANCE_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash < 0
    ? { name: rest }
    : { name: rest.slice(0, slash), output: rest.slice(slash + 1) };
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
  const instance = parseInstanceUri(uri);
  if (instance) return { kind: "instance", ...instance };
  return undefined;
}

/** The pseudo-source URI a `dataset` or `input` node is chosen as. */
export function pseudoUriOf(input: ExecutionInput): string | undefined {
  if (input.kind === "dataset") return columnUri(input.field);
  if (input.kind === "input") return inputUri(input.half, input.path);
  if (input.kind === "instance") return instanceUri(input.name, input.output);
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
function targetsOf(
  options: Pick<
    PseudoSourceOptions,
    "functionParameters" | "executeParameters"
  >,
): Target[] {
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
  const targets = targetsOf(options);
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
    note = type ? "column from dataset" : "column no longer exists";
  } else if (input.kind === "input") {
    const { half, path } = input;
    type = targetsOf(options).find(
      t => t.half === half && t.path === path,
    )?.type;
    note = type ? "same value as that input" : "input no longer exists";
  }
  return type && !typesFit(type, slotType)
    ? { note, warning: `${type.syntax} into ${slotType.syntax}` }
    : { note };
}

/** A run's instances, as the picker needs them: by name, in listing order. */
type InstanceUris = Readonly<Record<string, { uri: string }>>;

/**
 * `resources` with the run's instances (and their outputs) listed first, as
 * **Resources in this run**, and the catalog moved under **New** once there
 * is any instance to list ahead of it. See {@link withInstanceSources}.
 */
export function withInstanceResources(
  resources: readonly ResourceInfo[],
  instances: InstanceUris,
): ResourceInfo[] {
  const named = Object.entries(instances);
  if (named.length === 0) return [...resources];
  const byUri = new Map(resources.map(r => [r.uri, r]));
  const outputsOf = new Map<string, ResourceInfo[]>();
  for (const r of resources) {
    if (r.parent) {
      outputsOf.set(r.parent, [...(outputsOf.get(r.parent) ?? []), r]);
    }
  }
  const instanceEntries: ResourceInfo[] = named.flatMap(([name, { uri }]) => {
    const root = byUri.get(uri);
    const scope = root?.scope ?? "run";
    return [
      {
        uri: instanceUri(name),
        label: name,
        scope,
        group: [INSTANCES_GROUP],
        // A static resource's instance is its value: the slot previews it.
        ...(root?.value !== undefined && { value: root.value }),
      },
      ...(outputsOf.get(uri) ?? []).map(
        (output): ResourceInfo => ({
          uri: instanceUri(name, output.uri.slice(uri.length + 1)),
          label: output.label,
          scope,
          group: [INSTANCES_GROUP],
          parent: instanceUri(name),
          ...(output.value !== undefined && { value: output.value }),
        }),
      ),
    ];
  });
  return [
    ...instanceEntries,
    ...resources.map(r =>
      isPseudoUri(r.uri) ? r : { ...r, group: [NEW_GROUP, ...(r.group ?? [])] },
    ),
  ];
}

/**
 * `slots` (slot path → offered URIs) with each run instance offered ahead of
 * the catalog entries it stands for: an instance of `seededTask` wherever
 * `seededTask` is offered, and its `taskId` wherever `seededTask.taskId` is.
 *
 * @param resources - The catalog, to tell an output's resource.
 */
export function withInstanceSlots(
  slots: Readonly<Record<string, string[]>> | undefined,
  resources: readonly ResourceInfo[],
  instances: InstanceUris,
): Record<string, string[]> {
  const named = Object.entries(instances);
  if (named.length === 0) return { ...slots };
  const parentOf = new Map(
    resources.flatMap(r => (r.parent ? [[r.uri, r.parent] as const] : [])),
  );
  return Object.fromEntries(
    Object.entries(slots ?? {}).map(([path, offered]) => {
      const fitting: string[] = [];
      for (const [name, { uri }] of named) {
        for (const candidate of offered) {
          if (candidate === uri) fitting.push(instanceUri(name));
          else if (parentOf.get(candidate) === uri) {
            fitting.push(instanceUri(name, candidate.slice(uri.length + 1)));
          }
        }
      }
      return [path, [...fitting, ...offered]];
    }),
  );
}

/**
 * `sources`, with the run's own instances offered first wherever their
 * resource (or one of its outputs) fits — the picker's **Resources in this
 * run** group — and the catalog moved under **New** once there is any
 * instance to list ahead of it. Picking from **New** adds an instance (see
 * `adoptCatalogPick`); picking from the instances group only references
 * one. No new matching is needed: an instance of `seededTask` fits wherever
 * `seededTask` does, and its `taskId` wherever `seededTask.taskId` does.
 *
 * @param instances - The run's instances, by name, in the order to list them.
 */
export function withInstanceSources(
  sources: PromptInputSources | undefined,
  instances: InstanceUris,
): PromptInputSources {
  const resources = sources?.resources ?? [];
  const extend = (slots: Record<string, string[]> | undefined) =>
    withInstanceSlots(slots, resources, instances);
  return {
    resources: withInstanceResources(resources, instances),
    functionSlots: extend(sources?.functionSlots),
    executeSlots: extend(sources?.executeSlots),
    ...(sources?.resourceSlots && {
      resourceSlots: Object.fromEntries(
        Object.entries(sources.resourceSlots).map(([uri, slots]) => [
          uri,
          extend(slots),
        ]),
      ),
    }),
  };
}

/**
 * What a chip for instance reference `uri` says: what it is, or that the run
 * no longer has it.
 *
 * @param options.rowsMayDeclare - In an eval, a name the eval doesn't
 *   declare is one each dataset row declares (`specs/resource-instances.md`
 *   §E), so it reads as that rather than as missing.
 */
export function describeInstanceSource(
  uri: string,
  instances: InstanceUris,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
  options: { rowsMayDeclare?: boolean } = {},
): { label: string; note: string; missing?: boolean } | undefined {
  const ref = parseInstanceUri(uri);
  if (!ref) return undefined;
  const instance = instances[ref.name];
  const label =
    ref.output === undefined ? ref.name : `${ref.name}.${ref.output}`;
  if (!instance) {
    return options.rowsMayDeclare
      ? { label, note: "declared by each row" }
      : { label, note: "resource no longer in this run", missing: true };
  }
  const resource = resourcesByUri.get(instance.uri);
  return { label, note: resource?.label ?? instance.uri };
}
