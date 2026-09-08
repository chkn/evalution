// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ResourceInfo } from "../../shared/types";

/**
 * One entry in the nested source menu {@link SourcePicker} renders — a
 * group, a resource, or one of its declared values.
 *
 * A single flexible shape covers every case (see {@link buildSourceTree}):
 * `children` present means the row opens a submenu on click rather than
 * choosing anything (a group always works this way; so does a resource with
 * more than one thing beneath it); `children` absent means the row is a leaf
 * and clicking it sends `uri`. `breadcrumb` is the full `"Group / Resource /
 * Value"` path to this entry, shown as the row's `title` — most useful once
 * a collapse has dropped the submenu that would otherwise make the path
 * visible.
 */
export interface SourceNode {
  kind: "group" | "resource" | "value";
  /** Display label for this menu entry. */
  label: string;
  /** Full breadcrumb path to this entry, rendered as its `title`. */
  breadcrumb: string;
  /**
   * The uri to send when this entry is clicked directly. Absent for a group,
   * and for a resource whose own value doesn't fit the slot — such a row
   * only opens its submenu.
   */
  uri?: string;
  /**
   * Submenu entries. Absent for a leaf. Present (and never empty) for a
   * group, and for a resource that has more than one selectable thing under
   * it — including a resource whose own value fits the slot, in which case
   * the first child is a leaf repeating the resource's own choice (see
   * {@link buildSourceTree}).
   */
  children?: SourceNode[];
}

/** An in-progress group node, before it's known whether it will collapse. */
interface GroupBucket {
  __group: true;
  label: string;
  breadcrumb: string;
  children: (SourceNode | GroupBucket)[];
}

function isBucket(entry: SourceNode | GroupBucket): entry is GroupBucket {
  return "__group" in entry;
}

/**
 * Build the nested menu {@link SourcePicker} renders for one slot, from the
 * *unfiltered* list of sources a prompt was offered plus the subset that
 * fits this particular slot.
 *
 * Three passes, described in `specs/resource-hierarchy.md` §E:
 *
 * 1. **Prune.** A source not in `matchedUris` is dropped, and so is a
 *    resource or group left with nothing selectable beneath it.
 * 2. **Collapse.** A container (a group, always; a resource, only when its
 *    own value doesn't fit this slot) left with exactly one selectable
 *    descendant *becomes* that descendant — its own submenu would have had
 *    nothing to disambiguate.
 * 3. **Label.** A resource collapsed because it only ever had one value
 *    (`siblings === 1`) keeps its own label; one collapsed because matching
 *    narrowed several values down to one keeps the composite `"Resource —
 *    Value"` label, since the submenu that would have named the value is
 *    gone.
 *
 * @param resources - Every source offered to the prompt (`ResourceInfo`
 *   entries: resources and their declared values), unfiltered.
 * @param matchedUris - The uris that fit the slot being edited.
 */
export function buildSourceTree(
  resources: readonly ResourceInfo[],
  matchedUris: ReadonlySet<string> | readonly string[],
): SourceNode[] {
  const matched =
    matchedUris instanceof Set ? matchedUris : new Set(matchedUris);

  const valuesByParent = new Map<string, ResourceInfo[]>();
  for (const r of resources) {
    if (r.parent === undefined) continue;
    const list = valuesByParent.get(r.parent);
    if (list) list.push(r);
    else valuesByParent.set(r.parent, [r]);
  }

  const items: { group: readonly string[]; node: SourceNode }[] = [];
  for (const root of resources) {
    if (root.parent !== undefined) continue; // a value, handled via its root
    const node = resolveResource(
      root,
      valuesByParent.get(root.uri) ?? [],
      matched,
    );
    if (node) items.push({ group: root.group ?? [], node });
  }

  return groupTree(items);
}

/** `["Tasks", "Regressions"]` + `"Task A"` → `"Tasks / Regressions / Task A"`. */
function breadcrumbOf(group: readonly string[], ...rest: string[]): string {
  return [...group, ...rest].join(" / ");
}

/** Prune + collapse one resource (and its declared values) for this slot. */
function resolveResource(
  root: ResourceInfo,
  values: readonly ResourceInfo[],
  matched: ReadonlySet<string>,
): SourceNode | null {
  const group = root.group ?? [];
  const breadcrumb = breadcrumbOf(group, root.label);
  const selfSelectable = matched.has(root.uri);
  const matchedValues = values.filter(v => matched.has(v.uri));

  const valueNode = (v: ResourceInfo): SourceNode => ({
    kind: "value",
    uri: v.uri,
    label: v.label,
    breadcrumb: breadcrumbOf(group, root.label, v.label),
  });

  if (!selfSelectable) {
    if (matchedValues.length === 0) return null; // nothing selectable here
    if (matchedValues.length === 1) {
      // Collapse: this resource's own row would have opened a submenu with
      // nothing left to disambiguate, so the value stands in for it.
      const only = matchedValues[0];
      const totalSiblings = only.siblings ?? values.length;
      return {
        kind: "value",
        uri: only.uri,
        // The value *is* the resource when it was the resource's only
        // declared value; otherwise the submenu that would have named it is
        // gone, so the composite label carries the disambiguation instead.
        label:
          totalSiblings === 1 ? root.label : `${root.label} — ${only.label}`,
        breadcrumb: breadcrumbOf(group, root.label, only.label),
      };
    }
    return {
      kind: "resource",
      label: root.label,
      breadcrumb,
      children: matchedValues.map(valueNode),
    };
  }

  if (matchedValues.length === 0) {
    // Selectable on its own, and nothing else to disambiguate — a plain leaf.
    return { kind: "resource", uri: root.uri, label: root.label, breadcrumb };
  }

  // The parent is itself a valid choice, so it heads its own submenu rather
  // than doubling as both an opener and a chooser (see §E).
  const selfEntry: SourceNode = {
    kind: "resource",
    uri: root.uri,
    label: root.label,
    breadcrumb,
  };
  return {
    kind: "resource",
    uri: root.uri,
    label: root.label,
    breadcrumb,
    children: [selfEntry, ...matchedValues.map(valueNode)],
  };
}

/**
 * Nest resolved resource nodes under their `group` path, merging modules
 * that declare the same (trimmed) path into one node, and collapsing any
 * group left with exactly one descendant.
 *
 * Ordering falls out of the input order alone: a group is created — and so
 * takes its place in its parent's children — at the position of its first
 * member, exactly as `specs/resource-hierarchy.md` §B requires.
 */
function groupTree(
  items: readonly { group: readonly string[]; node: SourceNode }[],
): SourceNode[] {
  const topLevel: (SourceNode | GroupBucket)[] = [];
  const byPath = new Map<string, GroupBucket>();

  for (const { group, node } of items) {
    let siblings = topLevel;
    let pathKey = "";
    const seen: string[] = [];
    for (const segment of group) {
      pathKey = pathKey ? `${pathKey}/${segment}` : segment;
      seen.push(segment);
      let bucket = byPath.get(pathKey);
      if (!bucket) {
        bucket = {
          __group: true,
          label: segment,
          breadcrumb: breadcrumbOf(seen),
          children: [],
        };
        byPath.set(pathKey, bucket);
        siblings.push(bucket);
      }
      siblings = bucket.children;
    }
    siblings.push(node);
  }

  return finalize(topLevel);
}

/** Recursively collapses any bucket left with exactly one resolved child. */
function finalize(
  entries: readonly (SourceNode | GroupBucket)[],
): SourceNode[] {
  const resolved: SourceNode[] = [];
  for (const entry of entries) {
    if (!isBucket(entry)) {
      resolved.push(entry);
      continue;
    }
    const children = finalize(entry.children);
    if (children.length === 0) continue; // every member pruned away
    if (children.length === 1) {
      resolved.push(children[0]); // nothing left to disambiguate
    } else {
      resolved.push({
        kind: "group",
        label: entry.label,
        breadcrumb: entry.breadcrumb,
        children,
      });
    }
  }
  return resolved;
}

/** Every selectable `uri` reachable under `nodes`, depth-first. */
export function flattenSourceTree(nodes: readonly SourceNode[]): SourceNode[] {
  const out: SourceNode[] = [];
  const walk = (list: readonly SourceNode[]) => {
    for (const node of list) {
      if (node.uri !== undefined) out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
