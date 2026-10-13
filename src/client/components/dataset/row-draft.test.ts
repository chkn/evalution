// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { DatasetRow } from "../../../shared/types.ts";
import {
  draftBase,
  draftRow,
  foldDraft,
  hasChanges,
  isStale,
  mergeUpdates,
} from "./row-draft.ts";

const stored: DatasetRow = {
  id: "r1",
  createdAt: 0,
  cells: { "0": { kind: "value", value: { kind: "primitive", value: "a" } } },
  resources: { t: { uri: "x#t" } },
};
const v = (value: string) =>
  ({ kind: "value", value: { kind: "primitive", value } }) as const;

describe("row drafts", () => {
  it("fold proposals into one update, the later winning", () => {
    let draft = foldDraft(undefined, stored, {
      rowId: "r1",
      cells: { "0": v("b") },
      resources: { u: { uri: "x#u" } },
    });
    draft = foldDraft(draft, stored, {
      rowId: "r1",
      cells: { "0": v("c") },
      resources: { u: null, t: null },
    });
    expect(draft.update).toEqual({
      rowId: "r1",
      cells: { "0": v("c") },
      resources: { u: null, t: null },
    });
    expect(draftRow(draft)).toEqual({
      id: "r1",
      createdAt: 0,
      cells: { "0": v("c") },
    });
    expect(hasChanges(draft)).toBe(true);
  });

  it("start afresh for another row", () => {
    const other = { ...stored, id: "r2" };
    const draft = foldDraft(
      foldDraft(undefined, stored, { rowId: "r1", cells: {} }),
      other,
      { rowId: "r2", cells: {} },
    );
    expect(draft.base).toBe(other);
  });

  it("have no changes when they put things back", () => {
    const draft = foldDraft(undefined, stored, {
      rowId: "r1",
      cells: { "0": v("a") },
    });
    expect(hasChanges(draft)).toBe(false);
    expect(hasChanges(undefined)).toBe(false);
  });

  it("have no changes when an instance is added and removed again", () => {
    // Applying the update moves `resources` after `createdAt`: the same row,
    // spelled differently.
    const row: DatasetRow = {
      id: "r1",
      cells: {},
      resources: { t: { uri: "x#t" } },
      createdAt: 0,
    };
    let draft = foldDraft(undefined, row, {
      rowId: "r1",
      cells: {},
      resources: { u: { uri: "x#u" } },
    });
    draft = foldDraft(draft, row, {
      rowId: "r1",
      cells: {},
      resources: { u: null },
    });
    expect(hasChanges(draft)).toBe(false);
    expect(draftBase(draft, "r1")).toBeUndefined();
  });

  it("go stale when the stored row changes under them", () => {
    const draft = foldDraft(undefined, stored, { rowId: "r1", cells: {} });
    expect(isStale(draft, { ...stored })).toBe(false);
    expect(isStale(draft, { ...stored, cells: {} })).toBe(true);
  });

  it("merge updates without inventing resources", () => {
    expect(
      mergeUpdates({ rowId: "r", cells: {} }, { rowId: "r", cells: {} }),
    ).toEqual({ rowId: "r", cells: {} });
  });

  it("hand a view the stored row they started from, only while they change something", () => {
    const changed = foldDraft(undefined, stored, {
      rowId: "r1",
      cells: { "0": v("b") },
    });
    expect(draftBase(changed, "r1")).toBe(stored);
    // Another row, no draft, or one that put things back: nothing to compare.
    expect(draftBase(changed, "r2")).toBeUndefined();
    expect(draftBase(undefined, "r1")).toBeUndefined();
    const reverted = foldDraft(undefined, stored, {
      rowId: "r1",
      cells: { "0": v("a") },
    });
    expect(draftBase(reverted, "r1")).toBeUndefined();
  });
});
