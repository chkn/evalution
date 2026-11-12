// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  nextSort,
  parseTableModeMemory,
  sortItems,
  tableModeWidth,
  toggleTableMode,
} from "./summary-list";

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

describe("toggleTableMode", () => {
  it("goes to the default width the first time, remembering the width it left", () => {
    const { memory, width } = toggleTableMode(
      { current: 0, widths: [undefined, undefined] },
      224,
      400,
    );
    expect(width).toBe(400);
    expect(memory).toEqual({ current: 1, widths: [224, undefined] });
  });

  it("returns to the other mode's width, remembering this one's", () => {
    const { memory, width } = toggleTableMode(
      { current: 1, widths: [224, undefined] },
      450, // dragged while here
      400,
    );
    expect(width).toBe(224);
    expect(memory).toEqual({ current: 0, widths: [224, 450] });
  });

  it("goes back to a width it last had, however narrow", () => {
    const { memory, width } = toggleTableMode(
      { current: 0, widths: [224, 250] },
      260,
      400,
    );
    expect(width).toBe(250);
    expect(memory).toEqual({ current: 1, widths: [260, 250] });
  });
});

describe("parseTableModeMemory", () => {
  it("keeps valid widths and the current mode", () => {
    expect(parseTableModeMemory({ current: 1, widths: [224, 450] })).toEqual({
      current: 1,
      widths: [224, 450],
    });
  });

  it("discards what isn't a width", () => {
    expect(
      parseTableModeMemory({ current: "x", widths: ["wide", -1] }),
    ).toEqual({ current: 0, widths: [undefined, undefined] });
    expect(parseTableModeMemory(null)).toEqual({
      current: 0,
      widths: [undefined, undefined],
    });
  });
});
