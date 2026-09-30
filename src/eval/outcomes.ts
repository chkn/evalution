// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * `specs/evals.md` §B.3's table, as pure functions: what a check returned, or
 * threw, turned into an outcome.
 */

import type { CheckOutcome } from "../prompt/playground/check.ts";
import type { EvalCheckOutcome } from "./eval-types.ts";

/** A check's verdict, before it's keyed to a run and row. */
export interface JudgedOutcome {
  outcome: EvalCheckOutcome;
  score?: number;
  message?: string;
  details?: unknown;
}

/** Pass or fail for `score` against `threshold`, or just the score without one. */
function scored(
  score: number,
  threshold: number | undefined,
  rest: Omit<JudgedOutcome, "outcome" | "score"> = {},
): JudgedOutcome {
  if (threshold === undefined) return { outcome: "scored", score, ...rest };
  return {
    outcome: score >= threshold ? "pass" : "fail",
    score,
    ...(score < threshold && {
      message: `Score ${score} is below the threshold of ${threshold}`,
    }),
    ...rest,
  };
}

/**
 * What a check's `run` returned, as an outcome:
 *
 * | returned | outcome |
 * | --- | --- |
 * | `undefined` or `true` | `pass` |
 * | `false` | `fail` |
 * | a number | a score: `pass`/`fail` against `threshold`, else `scored` |
 * | an object | its fields, as given |
 *
 * Anything else a check returns is a mistake in the check, so it's an
 * `error`.
 *
 * @param threshold - The eval's threshold for this check, if it set one.
 */
export function outcomeFromReturn(
  value: CheckOutcome | unknown,
  threshold?: number,
): JudgedOutcome {
  if (value === undefined || value === null || value === true) {
    return { outcome: "pass" };
  }
  if (value === false) return { outcome: "fail" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { outcome: "error", message: `Check returned ${value}` };
    }
    return scored(value, threshold);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const { pass, score, message, details } = value as {
      pass?: unknown;
      score?: unknown;
      message?: unknown;
      details?: unknown;
    };
    const rest = {
      ...(typeof message === "string" && { message }),
      ...(details !== undefined && { details }),
    };
    const numeric = typeof score === "number" && Number.isFinite(score);
    if (typeof pass === "boolean") {
      return {
        outcome: pass ? "pass" : "fail",
        ...(numeric && { score: score as number }),
        ...rest,
      };
    }
    if (numeric) return scored(score as number, threshold, rest);
    return { outcome: "pass", ...rest };
  }
  return {
    outcome: "error",
    message: `Check returned ${JSON.stringify(value)}, which isn't a verdict`,
  };
}

/**
 * What a check threw, as an outcome: an error named `AssertionError` —
 * `node:assert`, chai, Vitest's `expect` — is a `fail`, with `expected` and
 * `actual` in `details` when it has them. Anything else is an `error`: a
 * check that throws a `TypeError` is broken, not failing, and the two call
 * for different fixes.
 */
export function outcomeFromError(err: unknown): JudgedOutcome {
  const message = err instanceof Error ? err.message : String(err);
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AssertionError"
  ) {
    const { expected, actual } = err as {
      expected?: unknown;
      actual?: unknown;
    };
    const hasDetails = "expected" in err || "actual" in err;
    return {
      outcome: "fail",
      message,
      ...(hasDetails && { details: { expected, actual } }),
    };
  }
  return { outcome: "error", message };
}
