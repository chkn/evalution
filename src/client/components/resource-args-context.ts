// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ResourceInfo } from "../../shared/types";
import {
  type ResourceArgs,
  rootResourceUri,
  type Selections,
  type SlotSelection,
} from "./execution-input-state";

/**
 * Nesting cap on a resource's own argument form — a resource whose argument
 * is a resource whose argument is a resource. `ResourceRegistry`'s cycle
 * check (`specs/resource-arguments.md` §D) is the backstop for anything past
 * this; this is purely about the panel not growing an unbounded column of
 * nested forms.
 */
export const MAX_RESOURCE_ARG_DEPTH = 3;

/**
 * Who owns a resource's first selection: `path` is its identity (compared
 * for equality — see {@link ResourceArgsContext.path}), `label` is what a
 * later chip's "same instance as X above" note displays for it.
 *
 * The two are deliberately different things. Two rows can easily share a
 * *label* — a prompt's own `taskId` parameter and some other resource's own
 * `taskId` argument are both just named `"taskId"` — so identity has to come
 * from each row's full position in the tree, not from what it's called.
 */
export interface ClaimOwner {
  /** Unique path identifying the owning row — see {@link ResourceArgsContext.path}. */
  path: string;
  /** Display name for the "same instance as X above" note. */
  label: string;
}

/**
 * Everything `SourceRow` needs to render a chosen resource's argument form —
 * bundled into one object so it threads through `ExecutionInputEditor` and
 * `CombinedInputEditor` as a single prop rather than five. See
 * `specs/resource-arguments.md` §I, §J.
 */
export interface ResourceArgsContext {
  /** The panel's whole argument-editor state, keyed by resource `uri`. */
  resourceArgs: ResourceArgs;
  /** Replaces one resource's argument selections. */
  onResourceArgsChange: (uri: string, next: Selections) => void;
  /**
   * Resource `uri` → (argument slot path → URIs of sources that can fill
   * it) — `PromptInputSources.resourceSlots`, unpacked.
   */
  resourceSlots: Record<string, Record<string, string[]>>;
  /**
   * Resource `uri` → the row that owns its *first* selection — every other
   * selection of that `uri` is the same instance, not a fresh one, and
   * `SourceRow` says so on the chip instead of repeating an argument form
   * (§I's "one binding per resource" rule) it wouldn't own anyway. Computed
   * once per render by {@link computeClaims}, from the same selections that
   * will render, rather than mutated as rows render: `SourceRow` only ever
   * reads this, which is what keeps it safe under React StrictMode's
   * double-invoked renders.
   */
  claimed: ReadonlyMap<string, ClaimOwner>;
  /**
   * This row's own unique position in the whole tree — `"fn.taskId"` for a
   * top-level function parameter, `"fn.toolsContext.list_tasks.db"` for a
   * nested field within one, `"fn.taskId.args.title"` for an argument of
   * whatever `fn.taskId` resolved to. Compared against
   * {@link ClaimOwner.path} to decide "is this row the owner?" — never
   * against a bare name, which is what let two same-named rows (a prompt's
   * own `taskId` and some resource's own `taskId` argument) collide.
   */
  path: string;
  /** How many resource-argument forms deep this row already is. */
  depth: number;
}

/**
 * `context`, moved to the child at `pathSuffix` (appended with `.`) and one
 * level deeper — for a nested field within the current slot, or an argument
 * of the resource the current slot resolved to.
 */
export function nested(
  context: ResourceArgsContext,
  pathSuffix: string,
): ResourceArgsContext {
  return {
    ...context,
    path: `${context.path}.${pathSuffix}`,
    depth: context.depth + 1,
  };
}

/**
 * `context`, moved to a nested field *within the current slot* — a `db`
 * field buried inside `toolsContext`, say. Only the path grows; `depth`
 * doesn't, because this isn't argument nesting at all, just a different
 * field of the same top-level selection. (Crossing into a *resource's own*
 * arguments is what {@link nested} is for, and that's the one the depth cap
 * applies to.)
 */
export function nestedField(
  context: ResourceArgsContext,
  pathSuffix: string,
): ResourceArgsContext {
  return { ...context, path: `${context.path}.${pathSuffix}` };
}

/**
 * Precomputes, for every resource selected anywhere in the panel, which row
 * "owns" its first selection — the first one reached walking `entries` in
 * order, and within a slot's own nested resource choices, in whatever order
 * they appear there. Recurses into an owning resource's own argument
 * selections (up to {@link MAX_RESOURCE_ARG_DEPTH}), so a resource chosen as
 * *another* resource's argument gets claimed too — whether or not either one
 * takes arguments itself: a resource with none still gets the same instance
 * both times it's picked, and `SourceRow`'s chip says so.
 *
 * Pure — no rendering, no mutation of anything the caller didn't just
 * allocate — so it can be recomputed on every render without StrictMode's
 * double-invocation ever observing a half-claimed map.
 *
 * @param entries - Top-level slots in panel order, each with the unique
 *   `path` and display `label` `SourceRow` would render it with (a function
 *   or execute parameter's own path, e.g. `"fn.taskId"`).
 */
export function computeClaims(
  entries: readonly {
    path: string;
    label: string;
    selection: SlotSelection | undefined;
  }[],
  resourceArgs: ResourceArgs,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): ReadonlyMap<string, ClaimOwner> {
  const claimed = new Map<string, ClaimOwner>();

  const visit = (
    path: string,
    label: string,
    selection: SlotSelection | undefined,
    depth: number,
  ) => {
    if (!selection?.resources || depth > MAX_RESOURCE_ARG_DEPTH) return;
    for (const [relPath, uri] of Object.entries(selection.resources)) {
      const root = rootResourceUri(uri, resourcesByUri);
      if (claimed.has(root)) continue;

      // A nested field's own row is identified by its full path, and
      // labelled by its own (leaf) name — the same as the `propDef.name`
      // `SourceRow` renders it with, matching `ExecutionInputEditor`'s
      // nested-slot plugin.
      const ownPath = relPath === "" ? path : `${path}.${relPath}`;
      const segments = relPath.split(".");
      const ownLabel = relPath === "" ? label : segments[segments.length - 1];
      claimed.set(root, { path: ownPath, label: ownLabel });

      // Only a resource that actually takes arguments has selections of its
      // own worth descending into — one that doesn't is still claimed above,
      // just with nothing beneath it to recurse into.
      const info = resourcesByUri.get(root);
      if (!info?.parameters || info.parameters.length === 0) continue;
      const argSelections = resourceArgs[root] ?? {};
      for (const param of info.parameters) {
        visit(
          `${ownPath}.args.${param.name}`,
          param.name,
          argSelections[param.name],
          depth + 1,
        );
      }
    }
  };

  for (const { path, label, selection } of entries) {
    visit(path, label, selection, 0);
  }

  return claimed;
}
