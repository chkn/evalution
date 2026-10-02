// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { DatasetRow } from "../../dataset/dataset-types.ts";
import type { TraceWithSpans } from "../../trace/trace-types.ts";
import type { ResolvedResourceInputs, ResourceInputs } from "./resource.ts";

/**
 * Brand identifying a value produced by {@link check} — a sibling of
 * `RESOURCE_TAG`, so the playground-module loader collects checks the same
 * way it collects resources. A registered symbol, so a check made by one copy
 * of evalution is still recognised by another.
 */
export const CHECK_TAG = Symbol.for("evalution.playground.check");

/** What a check is judging: one prompt run of one dataset row. */
export interface CheckRun {
  /** The run's trace, complete (`specs/evals.md` §D.3). */
  trace: TraceWithSpans;
  /** The dataset row, cells unresolved. */
  row: DatasetRow;
  /** Whether the prompt run itself succeeded. */
  status: "ok" | "error";
  /** The run's error, when {@link status} is `"error"`. */
  error?: string;
  /**
   * Set when the trace didn't finish arriving in time, so the checks ran on
   * whatever did. A check that reads the trace should report an error
   * rather than guess.
   */
  traceIncomplete?: boolean;
}

/**
 * What a check's `run` may return. See `specs/evals.md` §B.3:
 *
 * - `undefined` or `true` passes, `false` fails;
 * - a number is a score, which passes or fails only against the eval's
 *   threshold;
 * - an object gives its fields as-is.
 *
 * Throwing an error named `AssertionError` (`node:assert`, chai, Vitest's
 * `expect`) fails with its message; throwing anything else is an error.
 */
export type CheckOutcome =
  // biome-ignore lint/suspicious/noConfusingVoidType: a check that just asserts returns nothing
  | void
  | undefined
  | boolean
  | number
  | {
      pass?: boolean;
      score?: number;
      message?: string;
      details?: unknown;
    };

/** What {@link check} is given. */
export interface CheckDefinition<N extends ResourceInputs = ResourceInputs> {
  /** Human-readable label. Defaults to the export name. */
  label?: string;
  /** Display group in the check picker, `/`-separated for nesting. */
  group?: string;
  /** Shown beneath the label in the picker. */
  description?: string;
  /**
   * Exactly a resource's `inputs`: resources bound in code — resolved from
   * the run's own lease, so they're the instances the run used — and
   * Standard Schemas bound by the eval, from a column, a literal, another
   * slot, or a resource.
   */
  inputs?: N;
  /** Whether the check still runs when the prompt run itself errored. */
  runsOnError?: boolean;
  /** How long `run` may take before it's an `error`. Default 30s. */
  timeoutMs?: number;
  /**
   * Judges the run. Read-only by contract: a row's checks run concurrently.
   *
   * @param inputs - See {@link ResolvedResourceInputs}.
   * @param run - What is being judged. See {@link CheckRun}.
   */
  run(
    inputs: ResolvedResourceInputs<N>,
    run: CheckRun,
  ): CheckOutcome | Promise<CheckOutcome>;
}

/**
 * A check, as {@link check} returns it.
 *
 * @typeParam N - Its declared inputs.
 */
export type Check<N extends ResourceInputs = ResourceInputs> =
  CheckDefinition<N> & {
    /** @internal Identifies this object to the playground-module loader. */
    readonly [CHECK_TAG]: true;
  };

/**
 * Declares a check an eval can run against each row's prompt run — "did it
 * create a task called *Set up CI*?" — as a playground export, so it can use
 * the app's own schema and helpers.
 *
 * A check is a resource whose `create` is called once, after the run, and
 * returns a verdict instead of a value. Its `inputs` are a resource's: a
 * resource object is resolved from the run's own lease (the same database
 * the run's tools wrote to), and a Standard Schema is a parameter the eval
 * binds — often to a dataset column holding the expected value. See
 * `specs/evals.md` §B.
 *
 * @example
 * ```ts
 * // .evalution/playground/checks.ts
 * import { check } from 'evalution';
 * import { expect } from 'vitest';
 * import { db } from './db.ts';
 *
 * export const createsTask = check({
 *   label: 'Creates a task with the expected title',
 *   inputs: { db, rootTaskId: z.string(), title: z.string() },
 *   async run({ db, rootTaskId, title }) {
 *     const tasks = await listTasksUnder(db, rootTaskId);
 *     expect(tasks.map(t => t.title)).toContain(title);
 *   },
 * });
 * ```
 *
 * @param definition - See {@link CheckDefinition}.
 * @returns The check, to be exported under the name it should be known by.
 */
export function check<const N extends ResourceInputs = Record<string, never>>(
  definition: CheckDefinition<N>,
): Check<N> {
  return { ...definition, [CHECK_TAG]: true } as Check<N>;
}

/** Whether `value` was produced by {@link check}. */
export function isCheck(value: unknown): value is Check {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CHECK_TAG] === true
  );
}

/** The default {@link CheckDefinition.timeoutMs}. */
export const DEFAULT_CHECK_TIMEOUT_MS = 30_000;
