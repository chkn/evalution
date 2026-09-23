// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Recognizing and laying out answers to typed questions in a span's output —
 * TypeSafe System One's, and the Vercel AI SDK's `experimental_evaluate`'s.
 *
 * Matched by shape, not by provider: the same answers arrive from a playground
 * run and from a runtime trace sent over OTLP, where no adapter is involved.
 * The two dialects differ in their details (System One says `noul` where the
 * AI SDK says `boolean`, and always reports probabilities, confidence and a
 * score's legend, which the AI SDK may omit), so both are read into one shape
 * whose optional fields say what the provider reported.
 */

/** A yes/no answer: the probability of yes. */
export interface NoulAnswer {
  type: "noul";
  noul: number;
}

/** A choice between labels, with each label's probability when reported. */
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

/** An expected score on a rubric, with each level's probability when reported. */
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence?: number;
  legend?: Record<string, unknown>;
  probabilities?: Record<string, number>;
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

/** An optional field: absent, or valid by `check`. */
const optional = (v: unknown, check: (v: unknown) => boolean) =>
  v === undefined || check(v);

/**
 * One answer, of either dialect, in the shared shape — or `undefined` if `v`
 * isn't one. `question` is the question it answers, when known; a score's
 * levels are described by its criteria when the answer carries no legend.
 */
export function readAnswer(v: unknown, question?: unknown): Answer | undefined {
  if (!isRecord(v)) return undefined;
  switch (v.type) {
    case "noul":
      return isProbability(v.noul) ? { type: "noul", noul: v.noul } : undefined;
    case "boolean":
      // The AI SDK's name for it: `probability` is P(true), not confidence.
      return isProbability(v.probability)
        ? { type: "noul", noul: v.probability }
        : undefined;
    case "choice": {
      if (
        typeof v.choice !== "string" ||
        !optional(v.confidence, isProbability) ||
        !optional(
          v.probabilities,
          p => isProbabilities(p) && (v.choice as string) in p,
        )
      ) {
        return undefined;
      }
      return {
        type: "choice",
        choice: v.choice,
        ...(v.confidence !== undefined && {
          confidence: v.confidence as number,
        }),
        ...(v.probabilities !== undefined && {
          probabilities: v.probabilities as Record<string, number>,
        }),
      };
    }
    case "score": {
      if (
        typeof v.score !== "number" ||
        !Number.isFinite(v.score) ||
        !optional(v.confidence, isProbability) ||
        !optional(v.legend, isRecord) ||
        !optional(
          v.probabilities,
          p => isProbabilities(p) && Object.keys(p).every(k => /^\d+$/.test(k)),
        )
      ) {
        return undefined;
      }
      const legend = v.legend ?? criteriaLegend(question);
      return {
        type: "score",
        score: v.score,
        ...(v.confidence !== undefined && {
          confidence: v.confidence as number,
        }),
        ...(legend !== undefined && {
          legend: legend as Record<string, unknown>,
        }),
        ...(v.probabilities !== undefined && {
          probabilities: v.probabilities as Record<string, number>,
        }),
      };
    }
    default:
      return undefined;
  }
}

/** A score question's criteria as a legend, keyed by level. */
function criteriaLegend(
  question: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(question) || !Array.isArray(question.criteria))
    return undefined;
  return Object.fromEntries(question.criteria.map((c, i) => [String(i), c]));
}

/**
 * A span's output as answers, or `undefined` if it isn't a non-empty object
 * of them. `input` is the span's input, whose `questions` (when present)
 * describe what each answer answers.
 */
export function readAnswers(
  output: unknown,
  input?: unknown,
): Record<string, Answer> | undefined {
  if (!isRecord(output) || Object.keys(output).length === 0) return undefined;
  const questions =
    isRecord(input) && isRecord(input.questions) ? input.questions : {};
  const answers: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(output)) {
    const answer = readAnswer(value, questions[id]);
    if (!answer) return undefined;
    answers[id] = answer;
  }
  return answers;
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

/** A choice's options, or `[]` when the provider reported no probabilities. */
export function choiceRows(answer: ChoiceAnswer): ChoiceRow[] {
  return Object.entries(answer.probabilities ?? {}).map(
    ([label, probability]) => ({
      label,
      probability,
      chosen: label === answer.choice,
    }),
  );
}

/** One level of a score rubric. */
export interface ScoreLevel {
  level: number;
  /** The level's probability, when the provider reported a distribution. */
  probability?: number;
  /** The rubric's description of the level, as text, if it has one. */
  description?: string;
}

/**
 * A score answer's levels, lowest first: those of its distribution, or of its
 * legend when it has no distribution. `[]` when it has neither.
 */
export function scoreLevels(answer: ScoreAnswer): ScoreLevel[] {
  const keys = Object.keys(answer.probabilities ?? answer.legend ?? {});
  return keys
    .map(key => {
      const legend = answer.legend?.[key];
      const description =
        legend == null
          ? undefined
          : typeof legend === "string"
            ? legend
            : JSON.stringify(legend);
      const probability = answer.probabilities?.[key];
      return {
        level: Number(key),
        ...(probability !== undefined && { probability }),
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
