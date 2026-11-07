// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { markFreshEval, takeFreshEval } from "./fresh-evals";

describe("fresh evals", () => {
  it("is fresh once, for the eval that was marked", () => {
    markFreshEval("local-evals", "e1");
    expect(takeFreshEval("local-evals", "e2")).toBe(false);
    expect(takeFreshEval("other", "e1")).toBe(false);
    expect(takeFreshEval("local-evals", "e1")).toBe(true);
    expect(takeFreshEval("local-evals", "e1")).toBe(false);
  });
});
