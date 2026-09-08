// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { ResourceInfo } from "../../shared/types";
import { buildSourceTree, flattenSourceTree } from "./source-tree";

/** A root resource, with a label defaulting to its uri's key segment. */
function res(uri: string, overrides: Partial<ResourceInfo> = {}): ResourceInfo {
  return { uri, label: uri, scope: "run", ...overrides };
}

/** A value of `parentUri`, out of `siblings` declared total. */
function val(
  uri: string,
  parentUri: string,
  siblings: number,
  overrides: Partial<ResourceInfo> = {},
): ResourceInfo {
  return {
    uri,
    label: uri,
    scope: "run",
    parent: parentUri,
    siblings,
    ...overrides,
  };
}

describe("buildSourceTree", () => {
  it("nests resources under their group path", () => {
    const resources = [
      res("a#one", { label: "One", group: ["Tasks"] }),
      res("a#two", { label: "Two", group: ["Tasks"] }),
    ];
    const tree = buildSourceTree(resources, ["a#one", "a#two"]);

    expect(tree).toEqual([
      {
        kind: "group",
        label: "Tasks",
        breadcrumb: "Tasks",
        children: [
          {
            kind: "resource",
            uri: "a#one",
            label: "One",
            breadcrumb: "Tasks / One",
          },
          {
            kind: "resource",
            uri: "a#two",
            label: "Two",
            breadcrumb: "Tasks / Two",
          },
        ],
      },
    ]);
  });

  it("nests groups arbitrarily deep", () => {
    const resources = [
      res("a#one", { label: "One", group: ["Tasks", "Regressions"] }),
      res("a#two", { label: "Two", group: ["Tasks", "Regressions"] }),
      // A sibling directly under "Tasks", so it isn't left with only the
      // "Regressions" subgroup underneath it — which would itself collapse
      // away per the same rule tested below.
      res("a#three", { label: "Three", group: ["Tasks"] }),
    ];
    const tree = buildSourceTree(resources, ["a#one", "a#two", "a#three"]);

    expect(tree).toEqual([
      {
        kind: "group",
        label: "Tasks",
        breadcrumb: "Tasks",
        children: [
          {
            kind: "group",
            label: "Regressions",
            breadcrumb: "Tasks / Regressions",
            children: [
              {
                kind: "resource",
                uri: "a#one",
                label: "One",
                breadcrumb: "Tasks / Regressions / One",
              },
              {
                kind: "resource",
                uri: "a#two",
                label: "Two",
                breadcrumb: "Tasks / Regressions / Two",
              },
            ],
          },
          {
            kind: "resource",
            uri: "a#three",
            label: "Three",
            breadcrumb: "Tasks / Three",
          },
        ],
      },
    ]);
  });

  it("collapses a group left with only one subgroup underneath it, same as any other container", () => {
    const resources = [
      res("a#one", { label: "One", group: ["Tasks", "Regressions"] }),
      res("a#two", { label: "Two", group: ["Tasks", "Regressions"] }),
    ];
    const tree = buildSourceTree(resources, ["a#one", "a#two"]);

    // "Tasks" has nothing beneath it but "Regressions", so it becomes
    // "Regressions" directly rather than a redundant one-item submenu.
    expect(tree).toEqual([
      {
        kind: "group",
        label: "Regressions",
        breadcrumb: "Tasks / Regressions",
        children: [
          {
            kind: "resource",
            uri: "a#one",
            label: "One",
            breadcrumb: "Tasks / Regressions / One",
          },
          {
            kind: "resource",
            uri: "a#two",
            label: "Two",
            breadcrumb: "Tasks / Regressions / Two",
          },
        ],
      },
    ]);
  });

  it("merges two modules declaring the same group path into one node", () => {
    // Two resources with the same `group`, standing in for two separate
    // playground files that both say `group: "Tasks"` — the registry never
    // tags a source with which module it came from, so nothing here can even
    // tell them apart; the merge is just "same path, same node".
    const resources = [
      res("a#one", { label: "One", group: ["Tasks"] }),
      res("b#two", { label: "Two", group: ["Tasks"] }),
    ];
    const tree = buildSourceTree(resources, ["a#one", "b#two"]);

    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe("group");
    expect(tree[0].children).toHaveLength(2);
  });

  it("drops a group whose members all fail to fit the slot", () => {
    const resources = [
      res("a#one", { label: "One", group: ["Tasks"] }),
      res("a#two", { label: "Two", group: ["Tasks"] }),
      res("a#solo", { label: "Solo" }),
    ];
    // Neither "One" nor "Two" fits — only the ungrouped "Solo" does.
    const tree = buildSourceTree(resources, ["a#solo"]);

    expect(tree).toEqual([
      { kind: "resource", uri: "a#solo", label: "Solo", breadcrumb: "Solo" },
    ]);
  });

  it("collapses a resource with siblings === 1 to its own label", () => {
    const resources = [
      res("a#taskA", { label: "Task A" }),
      val("a#taskA.id", "a#taskA", 1, { label: "Task ID" }),
    ];
    // The resource's own uri doesn't fit, but its one declared value does —
    // and since it never had a sibling, the value *is* the resource.
    const tree = buildSourceTree(resources, ["a#taskA.id"]);

    expect(tree).toEqual([
      {
        kind: "value",
        uri: "a#taskA.id",
        label: "Task A",
        breadcrumb: "Task A / Task ID",
      },
    ]);
  });

  it("collapses a five-value resource narrowed to one match to 'Resource — Value'", () => {
    const resources = [
      res("a#taskA", { label: "Task A" }),
      val("a#taskA.id", "a#taskA", 5, { label: "Task ID" }),
      val("a#taskA.title", "a#taskA", 5, { label: "Task Name" }),
      val("a#taskA.info", "a#taskA", 5, { label: "Task Info" }),
      val("a#taskA.status", "a#taskA", 5, { label: "Status" }),
      val("a#taskA.owner", "a#taskA", 5, { label: "Owner" }),
    ];
    // Matching narrowed five declared values down to one for this slot — the
    // submenu that would have disambiguated the value is gone, so the label
    // carries it instead.
    const tree = buildSourceTree(resources, ["a#taskA.id"]);

    expect(tree).toEqual([
      {
        kind: "value",
        uri: "a#taskA.id",
        label: "Task A — Task ID",
        breadcrumb: "Task A / Task ID",
      },
    ]);
  });

  it("keeps a resource as a submenu when two or more of its values fit", () => {
    const resources = [
      res("a#taskA", { label: "Task A" }),
      val("a#taskA.id", "a#taskA", 3, { label: "Task ID" }),
      val("a#taskA.title", "a#taskA", 3, { label: "Task Name" }),
      val("a#taskA.info", "a#taskA", 3, { label: "Task Info" }),
    ];
    const tree = buildSourceTree(resources, ["a#taskA.id", "a#taskA.title"]);

    expect(tree).toEqual([
      {
        kind: "resource",
        label: "Task A",
        breadcrumb: "Task A",
        children: [
          {
            kind: "value",
            uri: "a#taskA.id",
            label: "Task ID",
            breadcrumb: "Task A / Task ID",
          },
          {
            kind: "value",
            uri: "a#taskA.title",
            label: "Task Name",
            breadcrumb: "Task A / Task Name",
          },
        ],
      },
    ]);
  });

  it("puts a resource that is itself selectable as the first entry of its own submenu", () => {
    const resources = [
      res("a#taskA", { label: "Task A" }),
      val("a#taskA.id", "a#taskA", 1, { label: "Task ID" }),
    ];
    // Both the resource's own value and its one declared value fit here —
    // unlike the siblings===1 case above, self *is* selectable, so it heads
    // its own submenu instead of collapsing into the value.
    const tree = buildSourceTree(resources, ["a#taskA", "a#taskA.id"]);

    expect(tree).toEqual([
      {
        kind: "resource",
        uri: "a#taskA",
        label: "Task A",
        breadcrumb: "Task A",
        children: [
          {
            kind: "resource",
            uri: "a#taskA",
            label: "Task A",
            breadcrumb: "Task A",
          },
          {
            kind: "value",
            uri: "a#taskA.id",
            label: "Task ID",
            breadcrumb: "Task A / Task ID",
          },
        ],
      },
    ]);
  });

  it("collapses a group pruned down to one member the same way a resource collapses", () => {
    const resources = [
      res("a#one", { label: "One", group: ["Tasks"] }),
      res("a#two", { label: "Two", group: ["Tasks"] }),
    ];
    // "Two" doesn't fit this slot; "Tasks" is left with exactly one member,
    // so it becomes that member rather than a one-item submenu.
    const tree = buildSourceTree(resources, ["a#one"]);

    expect(tree).toEqual([
      {
        kind: "resource",
        uri: "a#one",
        label: "One",
        breadcrumb: "Tasks / One",
      },
    ]);
  });

  it("orders deterministically and identically across two calls", () => {
    const resources = [
      res("a#one", { label: "One", group: ["Tasks"] }),
      res("a#two", { label: "Two", group: ["Tasks"] }),
      res("a#solo", { label: "Solo" }),
    ];
    const matched = ["a#one", "a#two", "a#solo"];

    expect(buildSourceTree(resources, matched)).toEqual(
      buildSourceTree(resources, matched),
    );
  });
});

describe("flattenSourceTree", () => {
  it("collects every selectable uri, depth-first", () => {
    const tree = buildSourceTree(
      [
        res("a#taskA", { label: "Task A" }),
        val("a#taskA.id", "a#taskA", 1, { label: "Task ID" }),
        res("a#solo", { label: "Solo" }),
      ],
      ["a#taskA", "a#taskA.id", "a#solo"],
    );

    expect(flattenSourceTree(tree).map(n => n.uri)).toEqual([
      "a#taskA",
      "a#taskA",
      "a#taskA.id",
      "a#solo",
    ]);
  });
});
