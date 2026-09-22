// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { nextSort, sortItems, tableModeWidth } from "./summary-list";

describe("nextSort", () => {
  it("flips direction when the same column is clicked again", () => {
    expect(nextSort({ key: "name", dir: "desc" }, "name")).toEqual({
      key: "name",
      dir: "asc",
    });
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({
      key: "name",
      dir: "desc",
    });
  });

  it("starts a new column descending", () => {
    expect(nextSort({ key: "name", dir: "asc" }, "cost")).toEqual({
      key: "cost",
      dir: "desc",
    });
  });
});

describe("sortItems", () => {
  const items = [
    { name: "b", n: 2 },
    { name: "a", n: undefined },
    { name: "c", n: 1 },
  ];

  it("sorts numbers either way, keeping undefined last", () => {
    expect(sortItems(items, i => i.n, "asc").map(i => i.name)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(sortItems(items, i => i.n, "desc").map(i => i.name)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("sorts strings, keeping undefined last rather than throwing", () => {
    const models = [
      { id: 1, model: "gpt" },
      { id: 2, model: undefined },
      { id: 3, model: "claude" },
    ];
    expect(sortItems(models, m => m.model, "asc").map(m => m.id)).toEqual([
      3, 1, 2,
    ]);
    expect(sortItems(models, m => m.model, "desc").map(m => m.id)).toEqual([
      1, 3, 2,
    ]);
  });

  it("doesn't mutate its input", () => {
    const copy = [...items];
    sortItems(items, i => i.n, "asc");
    expect(items).toEqual(copy);
  });
});

describe("tableModeWidth", () => {
  it("clamps up to the minimum for a few narrow columns", () => {
    expect(tableModeWidth([40])).toBe(340);
  });

  it("fits the Name column, the given columns, and chrome", () => {
    // 120 (Name) + 48 + 110 + 92 + 24 (chrome)
    expect(tableModeWidth([48, 110, 92])).toBe(394);
  });

  it("clamps down to the maximum", () => {
    expect(tableModeWidth([200, 200, 200])).toBe(480);
  });
});
