// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Recognizing and laying out System One answers in a span's output.
 *
 * Matched by shape, not by provider: the same answers arrive from a playground
 * run and from a runtime trace sent over OTLP, where no adapter is involved.
 */

/** A yes/no answer: the probability of yes. */
export interface NoulAnswer {
  type: "noul";
  noul: number;
}

/** A choice between labels, with each label's probability. */
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** An expected score on a rubric, with each level's probability. */
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const isProbability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const isProbabilities = (v: unknown): v is Record<string, number> =>
  isRecord(v) &&
  Object.keys(v).length > 0 &&
  Object.values(v).every(isProbability);

/** Whether `v` is one answer, of any of the three types, with its type's fields. */
export function isAnswer(v: unknown): v is Answer {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case "noul":
      return isProbability(v.noul);
    case "choice":
      return (
        typeof v.choice === "string" &&
        isProbability(v.confidence) &&
        isProbabilities(v.probabilities) &&
        v.choice in v.probabilities
      );
    case "score":
      return (
        typeof v.score === "number" &&
        Number.isFinite(v.score) &&
        isProbability(v.confidence) &&
        isRecord(v.legend) &&
        isProbabilities(v.probabilities) &&
        Object.keys(v.probabilities).every(k => /^\d+$/.test(k))
      );
    default:
      return false;
  }
}

/** Whether `v` is a set of System One answers: a non-empty object of answers. */
export function isSystemOneAnswers(v: unknown): v is Record<string, Answer> {
  return (
    isRecord(v) && Object.keys(v).length > 0 && Object.values(v).every(isAnswer)
  );
}

/** A probability as a whole percentage: `0.934` → `"93%"`. */
export function formatPercent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** One option of a choice answer, in the order its criteria were given. */
export interface ChoiceRow {
  label: string;
  probability: number;
  chosen: boolean;
}

export function choiceRows(answer: ChoiceAnswer): ChoiceRow[] {
  return Object.entries(answer.probabilities).map(([label, probability]) => ({
    label,
    probability,
    chosen: label === answer.choice,
  }));
}

/** One level of a score rubric. */
export interface ScoreLevel {
  level: number;
  probability: number;
  /** The rubric's description of the level, as text, if it has one. */
  description?: string;
}

/** A score answer's levels, lowest first. */
export function scoreLevels(answer: ScoreAnswer): ScoreLevel[] {
  return Object.entries(answer.probabilities)
    .map(([key, probability]) => {
      const legend = answer.legend[key];
      const description =
        legend == null
          ? undefined
          : typeof legend === "string"
            ? legend
            : JSON.stringify(legend);
      return {
        level: Number(key),
        probability,
        ...(description !== undefined && { description }),
      };
    })
    .sort((a, b) => a.level - b.level);
}

/**
 * Where an expected score falls along a level axis, as a fraction of its width.
 * Levels are drawn as equal-width bands, so level `i` is centred at
 * `(i + 0.5) / count` and the score interpolates between centres.
 */
export function scorePosition(
  score: number,
  levels: readonly ScoreLevel[],
): number {
  if (levels.length === 0) return 0;
  const first = levels[0].level;
  const last = levels[levels.length - 1].level;
  const clamped = Math.min(Math.max(score, first), last);
  const index =
    last === first
      ? 0
      : ((clamped - first) / (last - first)) * (levels.length - 1);
  return (index + 0.5) / levels.length;
}
