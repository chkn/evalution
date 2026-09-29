// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { diffWords } from "./text-diff";

/** Rebuilds either side from a diff, to check nothing was lost. */
const side = (segments: ReturnType<typeof diffWords>, which: "a" | "b") =>
  segments
    .filter(
      s => s.type === "same" || s.type === (which === "a" ? "del" : "add"),
    )
    .map(s => s.text)
    .join("");

describe("diffWords", () => {
  it("marks just the changed words in a long text", () => {
    const base = "You are Odin. ".repeat(50);
    const a = `${base}Answer briefly. ${base}`;
    const b = `${base}Answer in detail. ${base}`;
    const diff = diffWords(a, b);
    expect(diff.filter(s => s.type !== "same")).toEqual([
      { type: "del", text: "briefly." },
      { type: "add", text: "in detail." },
    ]);
    expect(side(diff, "a")).toBe(a);
    expect(side(diff, "b")).toBe(b);
  });

  it("handles insertions, deletions and identical text", () => {
    expect(diffWords("a b c", "a b c")).toEqual([
      { type: "same", text: "a b c" },
    ]);
    expect(diffWords("", "new")).toEqual([{ type: "add", text: "new" }]);
    expect(diffWords("old", "")).toEqual([{ type: "del", text: "old" }]);
    const diff = diffWords("one two three four", "one three four five");
    expect(side(diff, "a")).toBe("one two three four");
    expect(side(diff, "b")).toBe("one three four five");
    expect(diff.some(s => s.type === "del" && s.text.includes("two"))).toBe(
      true,
    );
    expect(diff.some(s => s.type === "add" && s.text.includes("five"))).toBe(
      true,
    );
  });

  it("rebuilds both sides of an arbitrary pair", () => {
    const a = "the quick brown fox jumps over the lazy dog again and again";
    const b = "a quick red fox leaps over lazy dogs again";
    const diff = diffWords(a, b);
    expect(side(diff, "a")).toBe(a);
    expect(side(diff, "b")).toBe(b);
  });
});
