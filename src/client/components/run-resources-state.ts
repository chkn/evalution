// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A run's named resource instances, as the Resources section edits them —
 * the client counterpart of `RunResources`, shared by the execute panel, the
 * eval Inputs panel and dataset row details. Pure; no React. See
 * `specs/resource-instances.md` §G, §H.
 */

import { isValidInstanceName } from "../../shared/instance-names";
import type { ResourceInfo, RunResources } from "../../shared/types";
import {
  fromExecutionInput,
  type Selections,
  type SlotSelection,
  toExecutionInput,
} from "./execution-input-state";
import { instanceUri, parseInstanceUri } from "./pseudo-sources";

/** One instance being edited: the resource it creates, and its argument editors by parameter name. */
export interface InstanceState {
  /** The resource's root `uri`. */
  uri: string;
  /** Argument editor state, by parameter name. */
  args: Selections;
}

/**
 * The run's instances, by name, in the order the section lists them —
 * insertion order, which a plain object keeps for names like these (none is
 * an integer-like key, since a name can't start with a digit).
 */
export type InstanceSelections = Record<string, InstanceState>;

/** The wire form of `instances`, or `undefined` when there are none. */
export function toWireResources(
  instances: InstanceSelections,
): RunResources | undefined {
  const entries = Object.entries(instances);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([name, { uri, args }]) => {
      const wireArgs = Object.fromEntries(
        Object.entries(args).flatMap(([param, selection]) => {
          const input = toExecutionInput(selection);
          return input ? [[param, input] as const] : [];
        }),
      );
      return [
        name,
        Object.keys(wireArgs).length > 0 ? { uri, args: wireArgs } : { uri },
      ];
    }),
  );
}

/** Editor state for a stored or recorded `resources`, receipts dropped. */
export function fromWireResources(
  resources: RunResources | undefined,
): InstanceSelections {
  if (!resources || typeof resources !== "object") return {};
  const out: InstanceSelections = {};
  for (const [name, spec] of Object.entries(resources)) {
    if (!spec || typeof spec.uri !== "string") continue;
    out[name] = {
      uri: spec.uri,
      args: Object.fromEntries(
        Object.entries(spec.args ?? {}).map(([param, input]) => [
          param,
          fromExecutionInput(input),
        ]),
      ),
    };
  }
  return out;
}

/**
 * A free name for a new instance of `uri`: its export name (`seededTask`),
 * or that with a number (`seededTask2`) when it's taken.
 */
export function defaultInstanceName(
  uri: string,
  taken: Iterable<string>,
): string {
  const used = new Set(taken);
  const exported = uri.slice(uri.lastIndexOf("#") + 1).split(".")[0] ?? "";
  let base = exported.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!isValidInstanceName(base)) base = `r_${base}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!used.has(`${base}${n}`)) return `${base}${n}`;
  }
}

/** `instances` with a new, argument-less instance of `uri` added at the end. */
export function addInstance(
  instances: InstanceSelections,
  uri: string,
): { instances: InstanceSelections; name: string } {
  const name = defaultInstanceName(uri, Object.keys(instances));
  return { instances: { ...instances, [name]: { uri, args: {} } }, name };
}

/**
 * The instance reference a catalog pick stands for: a server-scoped resource
 * already in the run is reused — it has one instance however it's named —
 * and anything else becomes a new instance, named by default. An output pick
 * (`seededTask.taskId`) references that output of the new instance.
 *
 * @returns The instances to keep, and the pseudo-source URI to bind.
 */
export function adoptCatalogPick(
  instances: InstanceSelections,
  pickedUri: string,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): { instances: InstanceSelections; uri: string } {
  const picked = resourcesByUri.get(pickedUri);
  const rootUri = picked?.parent ?? pickedUri;
  const output = picked?.parent
    ? pickedUri.slice(picked.parent.length + 1)
    : undefined;
  if (resourcesByUri.get(rootUri)?.scope === "server") {
    const existing = Object.entries(instances).find(
      ([, i]) => i.uri === rootUri,
    );
    if (existing) return { instances, uri: instanceUri(existing[0], output) };
  }
  const added = addInstance(instances, rootUri);
  return { instances: added.instances, uri: instanceUri(added.name, output) };
}

/** `selection`, with every reference to instance `from` pointed at `to` instead — or cleared, for `to: null`. */
function retargetSelection(
  selection: SlotSelection,
  from: string,
  to: string | null,
): SlotSelection {
  if (!selection.resources) return selection;
  let changed = false;
  const resources: Record<string, string> = {};
  for (const [path, uri] of Object.entries(selection.resources)) {
    const ref = parseInstanceUri(uri);
    if (ref?.name !== from) {
      resources[path] = uri;
      continue;
    }
    changed = true;
    if (to !== null) resources[path] = instanceUri(to, ref.output);
  }
  if (!changed) return selection;
  return Object.keys(resources).length > 0
    ? { ...selection, resources }
    : (({ resources: _, ...rest }) => rest)(selection);
}

/** `selections`, with every reference to instance `from` pointed at `to`, or cleared for `to: null`. Unchanged entries keep their identity. */
export function retargetSelections(
  selections: Selections,
  from: string,
  to: string | null,
): Selections {
  let changed = false;
  const out: Selections = {};
  for (const [key, selection] of Object.entries(selections)) {
    const next = retargetSelection(selection, from, to);
    if (next !== selection) changed = true;
    out[key] = next;
  }
  return changed ? out : selections;
}

/**
 * `instances` with `from` renamed to `to` in place (keeping its position),
 * and every argument referencing it pointed at the new name. The host
 * applies {@link retargetSelections} to its own slots the same way.
 *
 * @throws When `to` is invalid or already taken.
 */
export function renameInstance(
  instances: InstanceSelections,
  from: string,
  to: string,
): InstanceSelections {
  if (from === to) return instances;
  const problem = instanceNameProblem(to, instances, from);
  if (problem) throw new Error(problem);
  return Object.fromEntries(
    Object.entries(instances).map(([name, state]) => [
      name === from ? to : name,
      { ...state, args: retargetSelections(state.args, from, to) },
    ]),
  );
}

/** Why `name` can't be given to an instance (`self` being the one renamed), or `undefined` when it can. */
export function instanceNameProblem(
  name: string,
  instances: InstanceSelections,
  self?: string,
): string | undefined {
  if (!isValidInstanceName(name)) {
    return "Use letters, digits, '_' and '-', not starting with a digit or '-'.";
  }
  if (name !== self && Object.hasOwn(instances, name)) {
    return `There's already a resource named '${name}'.`;
  }
  return undefined;
}

/** `instances` without `name`, and with every argument that referenced it cleared. */
export function removeInstance(
  instances: InstanceSelections,
  name: string,
): InstanceSelections {
  return Object.fromEntries(
    Object.entries(instances)
      .filter(([n]) => n !== name)
      .map(([n, state]) => [
        n,
        { ...state, args: retargetSelections(state.args, name, null) },
      ]),
  );
}

/** `instances` with a copy of `name` — same resource, same arguments — right after it. */
export function duplicateInstance(
  instances: InstanceSelections,
  name: string,
): { instances: InstanceSelections; name: string } {
  const source = instances[name];
  if (!source) return { instances, name };
  const copy = defaultInstanceName(
    name.replace(/\d+$/, "") || name,
    Object.keys(instances),
  );
  const out: InstanceSelections = {};
  for (const [n, state] of Object.entries(instances)) {
    out[n] = state;
    if (n === name) {
      out[copy] = { uri: source.uri, args: structuredClone(source.args) };
    }
  }
  return { instances: out, name: copy };
}

/** Every place in `selection` that references instance `name`, as dotted paths below `prefix`. */
function referencesIn(
  selection: SlotSelection | undefined,
  name: string,
  prefix: string,
): string[] {
  return Object.entries(selection?.resources ?? {}).flatMap(([path, uri]) =>
    parseInstanceUri(uri)?.name === name
      ? [path === "" ? prefix : `${prefix}.${path}`]
      : [],
  );
}

/**
 * What references instance `name` — each slot (`taskId`,
 * `toolsContext.list_tasks.db`) and each other instance's argument
 * (`child1.parentId`) — for the card's "→ taskId" line.
 *
 * @param slots - The host's slot selections, each labelled by how a
 *   reference into it should read (`""` for slots named bare).
 */
export function referencesTo(
  name: string,
  instances: InstanceSelections,
  slots: readonly { prefix?: string; selections: Selections }[],
): string[] {
  const refs: string[] = [];
  for (const { prefix, selections } of slots) {
    for (const [slot, selection] of Object.entries(selections)) {
      refs.push(
        ...referencesIn(selection, name, prefix ? `${prefix}.${slot}` : slot),
      );
    }
  }
  for (const [other, state] of Object.entries(instances)) {
    if (other === name) continue;
    for (const [param, selection] of Object.entries(state.args)) {
      refs.push(...referencesIn(selection, name, `${other}.${param}`));
    }
  }
  return refs;
}

/** The instance names `state`'s arguments reference directly. */
function argumentTargets(state: InstanceState): Set<string> {
  const names = new Set<string>();
  for (const selection of Object.values(state.args)) {
    for (const uri of Object.values(selection.resources ?? {})) {
      const ref = parseInstanceUri(uri);
      if (ref) names.add(ref.name);
    }
  }
  return names;
}

/**
 * The instances `name`'s arguments may not reference, because creating them
 * means creating `name` first: itself, and every instance whose arguments
 * reach it. Offering those would only close a cycle.
 */
export function excludedFromArgs(
  instances: InstanceSelections,
  name: string,
): Set<string> {
  const excluded = new Set([name]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [other, state] of Object.entries(instances)) {
      if (excluded.has(other)) continue;
      if ([...argumentTargets(state)].some(t => excluded.has(t))) {
        excluded.add(other);
        grew = true;
      }
    }
  }
  return excluded;
}

/** A dependency the run doesn't declare an instance of, shown below the instances. */
export interface DerivedDependency {
  /** The dependency's resource uri. */
  uri: string;
  /** The instances (or other dependencies, by uri) whose resource needs it. */
  usedBy: string[];
  /**
   * The instances the run declares of it when there are several — a
   * dependency can't tell which to use, so the run would fail. Absent when
   * there are none.
   */
  ambiguous?: string[];
}

/**
 * The code-wired dependencies of the run's instances that the run doesn't
 * declare itself (`specs/resource-instances.md` §D): each is created with no
 * arguments, once, and shared by everything that needs it. Followed
 * transitively. A dependency the run declares exactly one instance of
 * resolves to that instance and isn't listed; one declared more than once is
 * listed with {@link DerivedDependency.ambiguous}.
 */
export function derivedDependencies(
  instances: InstanceSelections,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): DerivedDependency[] {
  const declaredBy = new Map<string, string[]>();
  for (const [name, state] of Object.entries(instances)) {
    declaredBy.set(state.uri, [...(declaredBy.get(state.uri) ?? []), name]);
  }

  const found = new Map<string, DerivedDependency>();
  const visit = (uri: string, user: string, seen: Set<string>) => {
    for (const dep of Object.values(
      resourcesByUri.get(uri)?.dependencies ?? {},
    )) {
      const declared = declaredBy.get(dep) ?? [];
      if (declared.length === 1) continue;
      let entry = found.get(dep);
      if (!entry) {
        entry = {
          uri: dep,
          usedBy: [],
          ...(declared.length > 1 && { ambiguous: declared }),
        };
        found.set(dep, entry);
      }
      if (!entry.usedBy.includes(user)) entry.usedBy.push(user);
      if (declared.length === 0 && !seen.has(dep)) {
        visit(
          dep,
          resourcesByUri.get(dep)?.label ?? dep,
          new Set([...seen, dep]),
        );
      }
    }
  };
  for (const [name, state] of Object.entries(instances)) {
    visit(state.uri, name, new Set([state.uri]));
  }
  return [...found.values()];
}
