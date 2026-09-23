// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropDefinition, PropValue } from "ts-proppy";
import type {
  ProbeResult,
  ProbeResults,
  TypeProbe,
} from "../../prompt/file/prompt-file-type.ts";
import type {
  NormalizedQuestionsPrompt,
  ParsedPrompt,
} from "../../shared/types.ts";
import { VERCEL_EVALUATION_FALLBACK } from "./evaluation-fallback.ts";

export const STATE_KEY = "state";
export const QUESTIONS_KEY = "questions";

/** Probe names, as reported in {@link ProbeResults}. */
export const EVALUATION_PROBE = {
  state: "evaluationState",
  questions: "evaluationQuestions",
} as const;

const evaluate = `Parameters<typeof import("ai").experimental_evaluate>[0]`;

/**
 * The types of an `experimental_evaluate` call's `state` and `questions`, read
 * from the installed `ai` — so a question type a later release adds is
 * editable without an Evalution release. (Its `model` is probed beside the
 * chat model, in `model-definition.ts`.)
 */
export const EVALUATION_PROJECT_PROBES: TypeProbe[] = [
  {
    kind: "type",
    name: EVALUATION_PROBE.state,
    expression: `${evaluate}["state"]`,
    syntax: "EvaluationInput",
    description:
      "What the questions are asked about: text, or a JSON object or array.",
  },
  {
    kind: "type",
    name: EVALUATION_PROBE.questions,
    // Not `${evaluate}["questions"]`: that is the call's generic parameter,
    // which resolves to its constraint only by accident.
    expression: `Record<string, import("ai").Experimental_EvaluationQuestion>`,
    syntax: "Record<string, EvaluationQuestion>",
    description: "Questions keyed by the names used to identify their answers.",
  },
];

/**
 * Whether a prompt's config is an `experimental_evaluate` call's, not a
 * `generateText` call's: it asks `questions`, which no chat config has.
 * Decided by the key alone, so a config whose questions are computed
 * (`questions: buildQuestions()`) is still recognized.
 */
export function isEvaluationPrompt(prompt: ParsedPrompt): boolean {
  return prompt.extractedProps.definitions.some(d => d.name === QUESTIONS_KEY);
}

/** The same test on a built config, at run time. */
export function isEvaluationConfig(config: unknown): boolean {
  return (
    !!config &&
    typeof config === "object" &&
    QUESTIONS_KEY in config &&
    !("messages" in config) &&
    !("prompt" in config)
  );
}

/** A probe's definition, or the checked-in snapshot's when it didn't resolve. */
function definition(
  project: ProbeResults,
  name: string,
): PropDefinition | undefined {
  const pick = (result: ProbeResult) =>
    result && !Array.isArray(result) ? result : undefined;
  return pick(project[name]) ?? pick(VERCEL_EVALUATION_FALLBACK[name]);
}

/**
 * An evaluation prompt, in the `questions` style. Its questions are object
 * literals of the SDK's question union (`{ type: "choice", … }`), so the
 * editor offers that union's cases rather than factories.
 */
export function normalizeEvaluationPrompt(
  prompt: ParsedPrompt,
  project: ProbeResults,
): NormalizedQuestionsPrompt {
  const values = prompt.extractedProps.values;
  const stateDef = definition(project, EVALUATION_PROBE.state) ?? {
    name: STATE_KEY,
    type: { kind: "opaque", syntax: "EvaluationInput" },
    optional: false,
  };
  const questionsDef = definition(project, EVALUATION_PROBE.questions) ?? {
    name: QUESTIONS_KEY,
    type: { kind: "opaque", syntax: "Record<string, EvaluationQuestion>" },
    optional: false,
  };
  return {
    style: "questions",
    id: prompt.id,
    providerId: prompt.providerId,
    globalId: prompt.globalId,
    name: prompt.name,
    functionParameters: prompt.functionParameters,
    metadata: prompt.metadata,
    treePath: prompt.treePath,
    model: values?.model,
    // Capabilities of `experimental_evaluate`: any model, state and questions.
    modelEditable: true,
    // Its other options (`maxRetries`, `headers`, …) are transport settings,
    // not prompt content; they stay in the file untouched.
    modelParameters: [],
    state: {
      def: { ...stateDef, name: STATE_KEY },
      value: values?.[STATE_KEY],
    },
    stateEditable: true,
    questions: {
      def: { ...questionsDef, name: QUESTIONS_KEY },
      value: values?.[QUESTIONS_KEY],
    },
    questionsEditable: true,
  };
}

/** Evaluation updates in source shape: the normalized fields are the config's keys. */
export function denormalizeEvaluationUpdates(updates: {
  model?: PropValue | null;
  state?: PropValue | null;
  questions?: PropValue | null;
}): Record<string, PropValue | null> {
  const out: Record<string, PropValue | null> = {};
  if ("model" in updates) out.model = updates.model ?? null;
  if ("state" in updates) out[STATE_KEY] = updates.state ?? null;
  if ("questions" in updates) out[QUESTIONS_KEY] = updates.questions ?? null;
  return out;
}
