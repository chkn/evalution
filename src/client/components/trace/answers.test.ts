// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  type ChoiceAnswer,
  choiceRows,
  formatPercent,
  readAnswers,
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

describe("readAnswers", () => {
  it("recognizes answers of every type", () => {
    const answers = {
      refund: { type: "noul", noul: 0.93 },
      team: choice,
      frustration: score,
    };
    expect(readAnswers(answers)).toEqual(answers);
  });

  it.each([
    ["an empty object", {}],
    ["text", "billing"],
    ["an array of answers", [{ type: "noul", noul: 0.5 }]],
    ["an unknown type", { a: { type: "rank", rank: 1 } }],
    ["a noul outside 0–1", { a: { type: "noul", noul: 1.5 } }],
    ["a choice not among its labels", { a: { ...choice, choice: "sales" } }],
    [
      "a score with empty probabilities",
      { a: { ...score, probabilities: {} } },
    ],
    [
      "a score keyed by non-levels",
      { a: { ...score, probabilities: { low: 1 } } },
    ],
    ["one non-answer among answers", { a: choice, b: { type: "noul" } }],
    ["structured output that happens to have a type", { a: { type: "noul" } }],
    ["a boolean without a probability", { a: { type: "boolean" } }],
    ["a confidence outside 0–1", { a: { ...choice, confidence: 2 } }],
  ])("rejects %s", (_, value) => {
    expect(readAnswers(value)).toBeUndefined();
  });
});

describe("readAnswers of AI SDK evaluations", () => {
  const input = {
    state: "I was charged twice.",
    questions: {
      severity: {
        type: "score",
        instructions: "How severe?",
        criteria: ["Cosmetic", "Workaround exists", "Blocking"],
      },
    },
  };

  it("reads a boolean's probability of true as a yes/no answer", () => {
    expect(
      readAnswers({ refund: { type: "boolean", probability: 0.88 } }),
    ).toEqual({ refund: { type: "noul", noul: 0.88 } });
  });

  it("reads choices and scores without probabilities or confidence", () => {
    expect(
      readAnswers({
        team: { type: "choice", choice: "billing" },
        severity: { type: "score", score: 1.2 },
      }),
    ).toEqual({
      team: { type: "choice", choice: "billing" },
      severity: { type: "score", score: 1.2 },
    });
  });

  it("keeps a confidence recorded from provider metadata", () => {
    expect(
      readAnswers({
        team: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.9, technical: 0.1 },
          confidence: 0.81,
        },
      })?.team,
    ).toMatchObject({ confidence: 0.81 });
  });

  it("describes a score's levels by its question's criteria", () => {
    const answers = readAnswers(
      {
        severity: {
          type: "score",
          score: 1.2,
          probabilities: { "0": 0.2, "1": 0.4, "2": 0.4 },
        },
      },
      input,
    );
    expect(scoreLevels(answers!.severity as ScoreAnswer)).toEqual([
      { level: 0, probability: 0.2, description: "Cosmetic" },
      { level: 1, probability: 0.4, description: "Workaround exists" },
      { level: 2, probability: 0.4, description: "Blocking" },
    ]);
  });

  it("lays out a score's levels from its criteria even without a distribution", () => {
    const answers = readAnswers(
      { severity: { type: "score", score: 2 } },
      input,
    );
    expect(scoreLevels(answers!.severity as ScoreAnswer)).toEqual([
      { level: 0, description: "Cosmetic" },
      { level: 1, description: "Workaround exists" },
      { level: 2, description: "Blocking" },
    ]);
  });

  it("has no choice rows without a distribution", () => {
    expect(choiceRows({ type: "choice", choice: "billing" })).toEqual([]);
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
