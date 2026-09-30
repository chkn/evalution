// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import assert from "node:assert";
import { describe, expect, it } from "vitest";
import { outcomeFromError, outcomeFromReturn } from "./outcomes.ts";

describe("outcomeFromReturn", () => {
  it("passes on undefined and true, fails on false", () => {
    expect(outcomeFromReturn(undefined)).toEqual({ outcome: "pass" });
    expect(outcomeFromReturn(true)).toEqual({ outcome: "pass" });
    expect(outcomeFromReturn(false)).toEqual({ outcome: "fail" });
  });

  it("reports a score on its own, or against a threshold", () => {
    expect(outcomeFromReturn(0.4)).toEqual({ outcome: "scored", score: 0.4 });
    expect(outcomeFromReturn(0.8, 0.5)).toEqual({
      outcome: "pass",
      score: 0.8,
    });
    expect(outcomeFromReturn(0.4, 0.5)).toMatchObject({
      outcome: "fail",
      score: 0.4,
      message: expect.stringMatching(/below the threshold/),
    });
  });

  it("takes an object's fields as given", () => {
    expect(
      outcomeFromReturn({ pass: false, message: "nope", details: { a: 1 } }),
    ).toEqual({ outcome: "fail", message: "nope", details: { a: 1 } });
    expect(outcomeFromReturn({ score: 0.9 }, 0.5)).toEqual({
      outcome: "pass",
      score: 0.9,
    });
    expect(outcomeFromReturn({ message: "fine" })).toEqual({
      outcome: "pass",
      message: "fine",
    });
  });

  it("treats anything else as a broken check", () => {
    expect(outcomeFromReturn("yes").outcome).toBe("error");
    expect(outcomeFromReturn(Number.NaN).outcome).toBe("error");
  });
});

describe("outcomeFromError", () => {
  it("fails on an AssertionError, keeping expected and actual", () => {
    let thrown: unknown;
    try {
      assert.strictEqual(1, 2);
    } catch (err) {
      thrown = err;
    }
    expect(outcomeFromError(thrown)).toMatchObject({
      outcome: "fail",
      details: { expected: 2, actual: 1 },
    });
  });

  it("fails on Vitest's own expect", () => {
    let thrown: unknown;
    try {
      expect([1, 2]).toContain(3);
    } catch (err) {
      thrown = err;
    }
    expect(outcomeFromError(thrown).outcome).toBe("fail");
  });

  it("errors on anything else", () => {
    expect(outcomeFromError(new TypeError("x is undefined"))).toEqual({
      outcome: "error",
      message: "x is undefined",
    });
  });
});
