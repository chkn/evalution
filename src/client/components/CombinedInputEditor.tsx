// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { shortSyntax } from "ts-proppy/react";
import type { PropDefinition, ResourceInfo } from "../../shared/types";
import type { CombinedSelection, FieldGroup } from "./combined-inputs";
import { memberCount } from "./combined-inputs";
import { ExecutionInputEditor } from "./ExecutionInputEditor";
import type { SlotSelection } from "./execution-input-state";

interface Props {
  /** The fan-out slot itself (e.g. `toolsContext`). */
  propDef: PropDefinition;
  /** This slot's deduped rows, from {@link fanOutGroups}. */
  groups: readonly FieldGroup[];
  /** Current editor state, one {@link SlotSelection} per group. */
  selection: CombinedSelection;
  /** Called with the slot's next state. */
  onChange: (selection: CombinedSelection) => void;
  /** Every resource in scope, for label lookup. */
  resources: readonly ResourceInfo[];
  /** Slot path → resource URIs, rooted at `propDef.name` (e.g. `inputSources.executeSlots`). */
  slots: Record<string, string[]>;
  /**
   * Group name → members whose value was overwritten the last time this slot
   * was forced into combined mode despite disagreeing. Cleared by the first
   * edit to that row.
   */
  overwritten?: Record<string, string[]>;
}

/**
 * The deduped list a fan-out slot's fields collapse into: one row per group,
 * each behaving exactly like a top-level slot by reusing
 * {@link ExecutionInputEditor} itself — the same control expanded mode uses,
 * keyed on the group's own name and type instead of one member's.
 */
export function CombinedInputEditor({
  propDef,
  groups,
  selection,
  onChange,
  resources,
  slots,
  overwritten,
}: Props) {
  const totalMembers = memberCount(groups);

  return (
    <>
      {groups.map(group => {
        const rowDef: PropDefinition = {
          name: group.name,
          type: group.type,
          optional: group.optional,
        };
        const dropped = droppedCandidates(slots, propDef.name, group);
        const overwrote = overwritten?.[group.name] ?? [];

        return (
          <div className="pg-exec-param pg-combined-row" key={group.name}>
            <div className="pg-exec-param-label">
              <span className="pg-exec-param-name">
                {group.name}
                {group.optional ? "" : " *"}
              </span>
              <span className="pg-exec-param-type" title={group.type.syntax}>
                {shortSyntax(group.type.syntax, 60)}
              </span>
              <span className="pg-combined-members">
                {memberLabel(group, totalMembers)}
              </span>
            </div>
            {overwrote.length > 0 && (
              <div className="pg-combined-note">
                Overwrote {overwrote.join(", ")}
              </div>
            )}
            {dropped.length > 0 && (
              <div className="pg-combined-note">
                {dropped.length === 1
                  ? "A matching resource is"
                  : `${dropped.length} matching resources are`}{" "}
                pinned to only some members and isn't offered here.
              </div>
            )}
            <ExecutionInputEditor
              propDef={rowDef}
              selection={selection.fields[group.name] ?? {}}
              onChange={(rowSelection: SlotSelection) =>
                onChange({
                  fields: { ...selection.fields, [group.name]: rowSelection },
                })
              }
              resources={resources}
              slots={rowSlots(slots, propDef.name, group)}
            />
          </div>
        );
      })}
    </>
  );
}

/** "all 4" when `group` covers every member, else the explicit member list. */
function memberLabel(group: FieldGroup, totalMembers: number): string {
  return group.members.length === totalMembers
    ? `all ${totalMembers}`
    : group.members.join(", ");
}

/**
 * The resource URIs matching *every* member's slot for `group` — the
 * intersection over `slots`, computed per member since matching (by type) is
 * what makes members agree by construction. Only narrower than any single
 * member's set when a resource was pinned with `for:` to one specific slot.
 */
function intersectAcrossMembers(
  slots: Record<string, string[]>,
  rootName: string,
  group: FieldGroup,
): string[] {
  const sets = group.members.map(
    m => new Set(slots[`${rootName}.${m}.${group.name}`] ?? []),
  );
  const [first, ...rest] = sets;
  if (!first) return [];
  return [...first].filter(uri => rest.every(s => s.has(uri)));
}

/** Resources some member matches but the intersection dropped. */
function droppedCandidates(
  slots: Record<string, string[]>,
  rootName: string,
  group: FieldGroup,
): string[] {
  const union = new Set(
    group.members.flatMap(m => slots[`${rootName}.${m}.${group.name}`] ?? []),
  );
  const intersection = new Set(intersectAcrossMembers(slots, rootName, group));
  return [...union].filter(uri => !intersection.has(uri));
}

/**
 * Re-root `slots` under `group.name`, as if it were the top-level slot
 * `ExecutionInputEditor` expects.
 *
 * The row's own dropdown (`slots[group.name]`) is the true intersection
 * across every member. Deeper nested paths (a field within `group.type` that
 * is itself an object) fall back to one representative member's paths —
 * combined mode merges only one level deep (§A), so this only matters for a
 * shape no current adapter produces.
 */
function rowSlots(
  slots: Record<string, string[]>,
  rootName: string,
  group: FieldGroup,
): Record<string, string[]> {
  const representative = group.members[0];
  const prefix = `${rootName}.${representative}.`;
  const rowRoot = `${prefix}${group.name}`;
  const out: Record<string, string[]> = {};

  for (const [path, uris] of Object.entries(slots)) {
    if (path === rowRoot || path.startsWith(`${rowRoot}.`)) {
      out[path.slice(prefix.length)] = uris;
    }
  }

  out[group.name] = intersectAcrossMembers(slots, rootName, group);
  return out;
}
