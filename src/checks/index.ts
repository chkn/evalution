// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * **evalution/checks** — the built-in checks an eval can run, and the trace
 * helpers they read the run with, which your own checks can import too. See
 * `specs/evals.md` §B.5.
 *
 * @module evalution/checks
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type Check,
  type CheckRun,
  check,
} from "../prompt/playground/check.ts";
import type { CheckInfo, PropDefinition } from "../shared/types.ts";
import type { Span, TraceWithSpans } from "../trace/trace-types.ts";

export type { CheckRun };

/** The URI prefix every built-in check's URI starts with. */
export const BUILTIN_CHECK_PREFIX = "evalution/checks#";

// #region Trace helpers

/** The trace's `LLM` spans, oldest first. */
function llmSpans(trace: TraceWithSpans): Span[] {
  return trace.spans
    .filter(s => s.kind === "LLM" && s.llm)
    .sort((a, b) => a.startTime - b.startTime);
}

/**
 * What the model finally answered: the output of the run's last `LLM` span —
 * text for a chat model, parsed JSON for structured output. `undefined` when
 * the run made no model call.
 */
export function finalOutput(trace: TraceWithSpans): unknown {
  return llmSpans(trace).at(-1)?.llm?.output;
}

/**
 * The final assistant text: {@link finalOutput} when it's text, its JSON when
 * it isn't, and `""` when the run made no model call.
 */
export function finalText(trace: TraceWithSpans): string {
  const output = finalOutput(trace);
  if (output === undefined || output === null) return "";
  return typeof output === "string" ? output : JSON.stringify(output);
}

/** One tool call a run made, as its `TOOL` span recorded it. */
export interface ToolCall {
  /** The tool's name. */
  name: string;
  /** What it was called with. */
  input: unknown;
  /** What it returned, if it finished. */
  output?: unknown;
  /** Whether the call failed. */
  error?: string;
}

/** Every tool call the run made, oldest first. */
export function toolCalls(trace: TraceWithSpans): ToolCall[] {
  return trace.spans
    .filter(s => s.kind === "TOOL")
    .sort((a, b) => a.startTime - b.startTime)
    .map(s => ({
      name: s.tool?.toolName ?? s.name,
      input: s.tool?.input,
      ...(s.tool?.output !== undefined && { output: s.tool.output }),
      ...(s.status === "error" && { error: s.errorMessage ?? "failed" }),
    }));
}

/** The run's total model cost in dollars, from every `LLM` span that reports one. */
export function totalCost(trace: TraceWithSpans): number {
  let total = 0;
  for (const span of trace.spans) {
    const cost = span.llm?.cost;
    if (cost) total += cost.prompt + cost.completion;
  }
  return total;
}

/** Whether any span in the trace reports a cost. */
export function hasCost(trace: TraceWithSpans): boolean {
  return trace.spans.some(s => !!s.llm?.cost);
}

/**
 * How long the run took, in ms: from its first span's start to its last
 * span's end. `undefined` while any span is still running.
 */
export function traceDuration(trace: TraceWithSpans): number | undefined {
  if (trace.spans.length === 0) {
    const { startTime, endTime } = trace.trace;
    return endTime === undefined ? undefined : endTime - startTime;
  }
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const span of trace.spans) {
    if (span.endTime === undefined) return undefined;
    start = Math.min(start, span.startTime);
    end = Math.max(end, span.endTime);
  }
  return end - start;
}

// #endregion
// #region Schemas

/**
 * A minimal Standard Schema, so the built-ins declare typed inputs without
 * evalution depending on a validation library.
 */
function schema<T>(
  vendorCheck: (value: unknown) => value is T,
  expected: string,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "evalution",
      validate: value =>
        vendorCheck(value)
          ? { value }
          : { issues: [{ message: `expected ${expected}` }] },
    },
  };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const optional =
  <T>(is: (v: unknown) => v is T) =>
  (v: unknown): v is T | undefined =>
    v === undefined || v === null || is(v);

const stringSchema = schema(isString, "a string");
const numberSchema = schema(isNumber, "a number");
const optionalNumber = schema(optional(isNumber), "a number");
const optionalBoolean = schema(
  optional((v): v is boolean => typeof v === "boolean"),
  "true or false",
);
const anySchema = schema((_v): _v is unknown => true, "anything");

// #endregion
// #region Built-ins

/** Throws the error a trace-reading built-in reports when the trace didn't finish arriving. */
function requireCompleteTrace(run: CheckRun): void {
  if (run.traceIncomplete) {
    throw new Error(
      "The trace didn't finish arriving in time, so this check can't read it",
    );
  }
}

/** Whether `a` and `b` are the same JSON value. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(k =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/** `value` parsed as JSON, or as it is when it isn't JSON text. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Passes when the final assistant text contains `text`. */
export const outputContains = check({
  label: "Output contains",
  description: "The final assistant text contains the given text.",
  inputs: { text: stringSchema, caseSensitive: optionalBoolean },
  run: ({ text, caseSensitive }, run) => {
    requireCompleteTrace(run);
    const output = finalText(run.trace);
    const found =
      caseSensitive === false || caseSensitive === undefined
        ? output.toLowerCase().includes(text.toLowerCase())
        : output.includes(text);
    return found
      ? { pass: true }
      : {
          pass: false,
          message: `Output doesn't contain ${JSON.stringify(text)}`,
          details: { actual: output },
        };
  },
});

/** Passes when the final output deep-equals `expected`, as text or as JSON. */
export const outputEquals = check({
  label: "Output equals",
  description: "The final output equals the expected value, as text or JSON.",
  inputs: { expected: anySchema },
  run: ({ expected }, run) => {
    requireCompleteTrace(run);
    const output = finalOutput(run.trace);
    const equal =
      typeof output === "string" && typeof expected === "string"
        ? output.trim() === expected.trim()
        : deepEqual(parseMaybeJson(output), parseMaybeJson(expected));
    return equal
      ? { pass: true }
      : {
          pass: false,
          message: "Output doesn't equal the expected value",
          details: { expected, actual: output },
        };
  },
});

/**
 * Passes when a `TOOL` span named `name` exists — exactly `times` of them, if
 * given. For the invariants where the call itself is the point ("it called
 * `success`"), not the world it changed.
 */
export const toolCalled = check({
  label: "Tool called",
  description: "The run called the named tool (exactly `times` times, if set).",
  inputs: { name: stringSchema, times: optionalNumber },
  run: ({ name, times }, run) => {
    requireCompleteTrace(run);
    const count = toolCalls(run.trace).filter(c => c.name === name).length;
    const pass =
      times === undefined || times === null ? count > 0 : count === times;
    return pass
      ? { pass: true }
      : {
          pass: false,
          message:
            times === undefined || times === null
              ? `'${name}' was never called`
              : `'${name}' was called ${count} time${count === 1 ? "" : "s"}, not ${times}`,
          details: { calls: count },
        };
  },
});

/** Passes when the run's total cost is at most `usd`. */
export const maxCost = check({
  label: "Max cost",
  description: "The run's total model cost is at most this many dollars.",
  inputs: { usd: numberSchema },
  run: ({ usd }, run) => {
    requireCompleteTrace(run);
    if (!hasCost(run.trace)) {
      throw new Error("The trace reports no cost to compare");
    }
    const cost = totalCost(run.trace);
    return cost <= usd
      ? { pass: true, details: { cost } }
      : {
          pass: false,
          message: `Cost $${cost.toFixed(4)} exceeds $${usd}`,
          details: { cost },
        };
  },
});

/** Passes when the run took at most `ms`. */
export const maxDuration = check({
  label: "Max duration",
  description: "The run took at most this many milliseconds.",
  inputs: { ms: numberSchema },
  run: ({ ms }, run) => {
    requireCompleteTrace(run);
    const duration = traceDuration(run.trace);
    if (duration === undefined) {
      throw new Error("The trace is still running");
    }
    return duration <= ms
      ? { pass: true, details: { duration } }
      : {
          pass: false,
          message: `Took ${duration}ms, over ${ms}ms`,
          details: { duration },
        };
  },
});

/** A built-in check, with its parameters written out (there's no checker to probe them with). */
interface BuiltinCheck {
  check: Check;
  parameters: PropDefinition[];
}

const primitive = (
  name: string,
  syntax: "string" | "number" | "boolean" | "unknown",
  isOptional = false,
): PropDefinition => ({
  name,
  type: {
    kind: "primitive",
    syntax,
    base: syntax === "unknown" ? "string" : syntax,
  },
  optional: isOptional,
});

/** Every built-in, by export name. */
const BUILTINS: Record<string, BuiltinCheck> = {
  outputContains: {
    check: outputContains,
    parameters: [
      primitive("text", "string"),
      primitive("caseSensitive", "boolean", true),
    ],
  },
  outputEquals: {
    check: outputEquals,
    parameters: [primitive("expected", "unknown")],
  },
  toolCalled: {
    check: toolCalled,
    parameters: [
      primitive("name", "string"),
      primitive("times", "number", true),
    ],
  },
  maxCost: { check: maxCost, parameters: [primitive("usd", "number")] },
  maxDuration: { check: maxDuration, parameters: [primitive("ms", "number")] },
};

/** The built-in check `uri` names, or `undefined` when it names none. */
export function builtinCheck(uri: string): Check | undefined {
  if (!uri.startsWith(BUILTIN_CHECK_PREFIX)) return undefined;
  return BUILTINS[uri.slice(BUILTIN_CHECK_PREFIX.length)]?.check;
}

/** Every built-in, as the check picker lists it. */
export function builtinCheckInfos(): CheckInfo[] {
  return Object.entries(BUILTINS).map(([name, { check: c, parameters }]) => ({
    uri: `${BUILTIN_CHECK_PREFIX}${name}`,
    label: c.label ?? name,
    group: "Built-in",
    ...(c.description && { description: c.description }),
    parameters,
  }));
}

// #endregion
