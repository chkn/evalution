// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  answersWithConfidence,
  evaluationConfidence,
} from "./evaluation-answers.ts";

describe("evaluationConfidence", () => {
  it("reads per-question confidence from any provider's namespace", () => {
    expect(
      evaluationConfidence({
        other: { note: "x" },
        typesafe: { confidence: { team: 0.8, severity: 0.6, bad: "x" } },
      }),
    ).toEqual({ team: 0.8, severity: 0.6 });
  });

  it("is empty without metadata", () => {
    expect(evaluationConfidence(undefined)).toEqual({});
  });
});

describe("answersWithConfidence", () => {
  const answers = {
    team: { type: "choice", choice: "billing" },
    refund: { type: "boolean", probability: 0.9 },
  };

  it("adds each answer's confidence, leaving the rest alone", () => {
    expect(
      answersWithConfidence(answers, {
        typesafe: { confidence: { team: 0.8 } },
      }),
    ).toEqual({
      team: { type: "choice", choice: "billing", confidence: 0.8 },
      refund: { type: "boolean", probability: 0.9 },
    });
  });

  it("returns the answers themselves when there's no confidence", () => {
    expect(answersWithConfidence(answers, {})).toBe(answers);
  });

  it("never overwrites a confidence the answer already has", () => {
    const own = { team: { type: "choice", choice: "a", confidence: 0.5 } };
    expect(
      answersWithConfidence(own, { p: { confidence: { team: 0.9 } } }),
    ).toEqual(own);
  });
});
