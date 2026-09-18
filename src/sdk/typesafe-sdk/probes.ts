// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TypeProbe } from "../../prompt/file/prompt-file-type.ts";

/** The TypeSafe SDK's package name. */
export const TYPESAFE_PACKAGE = "@typesafe-ai/sdk";

/** Probe names, as reported in project probe results. */
export const PROBE = {
  model: "model",
  state: "state",
  questions: "questions",
  factories: "questionFactories",
} as const;

const sdk = `import(${JSON.stringify(TYPESAFE_PACKAGE)})`;

/**
 * Everything the adapter needs to know about the installed SDK's types: the
 * request's `model`, `state` and `questions`, and every export that builds a
 * `Question` — `noul`, `choice`, `score`, and whatever a later version adds.
 */
export const TYPESAFE_PROJECT_PROBES: TypeProbe[] = [
  {
    kind: "type",
    name: PROBE.model,
    expression: `NonNullable<${sdk}.SystemOneRequest["model"]>`,
    syntax: "string",
    description: "The System One model to answer with.",
  },
  {
    kind: "type",
    name: PROBE.state,
    expression: `${sdk}.SystemOneRequest["state"]`,
    syntax: "EntryType",
    description:
      "What the questions are asked about: text, a JSON object or array, or null.",
  },
  {
    kind: "type",
    name: PROBE.questions,
    expression: `${sdk}.Questions`,
    syntax: "Questions",
    description: "Questions keyed by the names used to identify their answers.",
  },
  {
    kind: "factories",
    name: PROBE.factories,
    modules: [TYPESAFE_PACKAGE],
    produces: `${sdk}.Question`,
  },
];
