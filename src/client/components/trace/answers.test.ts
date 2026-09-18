// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  type ChoiceAnswer,
  choiceRows,
  formatPercent,
  isSystemOneAnswers,
  type ScoreAnswer,
  scoreLevels,
  scorePosition,
} from "./answers";

const choice: ChoiceAnswer = {
  type: "choice",
  choice: "billing",
  confidence: 0.9,
  probabilities: { technical: 0.1, billing: 0.9 },
};
const score: ScoreAnswer = {
  type: "score",
  score: 1.4,
  confidence: 0.7,
  legend: { "0": "Calm", "1": "Frustrated", "2": { tone: "Very angry" } },
  probabilities: { "2": 0.5, "0": 0.1, "1": 0.4 },
};

describe("isSystemOneAnswers", () => {
  it("recognizes answers of every type", () => {
    expect(
      isSystemOneAnswers({
        refund: { type: "noul", noul: 0.93 },
        team: choice,
        frustration: score,
      }),
    ).toBe(true);
  });

  it.each([
    ["an empty object", {}],
    ["text", "billing"],
    ["an array of answers", [{ type: "noul", noul: 0.5 }]],
    ["an unknown type", { a: { type: "rank", rank: 1 } }],
    ["a noul outside 0–1", { a: { type: "noul", noul: 1.5 } }],
    ["a choice not among its labels", { a: { ...choice, choice: "sales" } }],
    ["a score without probabilities", { a: { ...score, probabilities: {} } }],
    [
      "a score keyed by non-levels",
      { a: { ...score, probabilities: { low: 1 } } },
    ],
    ["one non-answer among answers", { a: choice, b: { type: "noul" } }],
    ["structured output that happens to have a type", { a: { type: "noul" } }],
  ])("rejects %s", (_, value) => {
    expect(isSystemOneAnswers(value)).toBe(false);
  });
});

describe("layout", () => {
  it("lists choice options in criteria order, marking the chosen one", () => {
    expect(choiceRows(choice)).toEqual([
      { label: "technical", probability: 0.1, chosen: false },
      { label: "billing", probability: 0.9, chosen: true },
    ]);
  });

  it("orders score levels numerically with their descriptions as text", () => {
    expect(scoreLevels(score)).toEqual([
      { level: 0, probability: 0.1, description: "Calm" },
      { level: 1, probability: 0.4, description: "Frustrated" },
      { level: 2, probability: 0.5, description: '{"tone":"Very angry"}' },
    ]);
  });

  it("places an expected score between level centres, clamped to the axis", () => {
    const levels = scoreLevels(score);
    expect(scorePosition(0, levels)).toBeCloseTo(1 / 6);
    expect(scorePosition(2, levels)).toBeCloseTo(5 / 6);
    expect(scorePosition(1.5, levels)).toBeCloseTo(4 / 6);
    expect(scorePosition(9, levels)).toBeCloseTo(5 / 6);
    expect(scorePosition(1, [{ level: 3, probability: 1 }])).toBe(0.5);
  });

  it("formats probabilities as whole percentages", () => {
    expect(formatPercent(0.934)).toBe("93%");
    expect(formatPercent(0)).toBe("0%");
  });
});
