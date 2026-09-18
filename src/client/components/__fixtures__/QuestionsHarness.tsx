// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type {
  NormalizedPromptUpdates,
  NormalizedQuestionsPrompt,
  PropDefinition,
  PropType,
  ValueFactory,
} from "../../../shared/types";
import PlaygroundEditor from "../PlaygroundEditor";

const text: PropType = { kind: "primitive", syntax: "string", base: "string" };
const entry: PropType = {
  kind: "union",
  syntax: "EntryType",
  types: [
    { kind: "constant", syntax: "null", value: null },
    text,
    {
      kind: "record",
      syntax: "{ [key: string]: JsonValue }",
      value: { name: "", optional: false, type: text },
    },
  ],
};
const def = (
  name: string,
  type: PropType,
  optional = false,
): PropDefinition => ({
  name,
  type,
  optional,
});

const choice: ValueFactory = {
  def: def("choice", {
    kind: "function",
    syntax:
      "(instructions: EntryType, criteria: ChoiceCriteria) => ChoiceQuestion",
    parameters: [
      def("instructions", entry),
      def("criteria", {
        kind: "record",
        syntax: "ChoiceCriteria",
        value: def("", entry),
      }),
    ],
  }),
  binding: {
    kind: "import",
    spec: { name: "choice", from: "@typesafe-ai/sdk" },
  },
};
const noul: ValueFactory = {
  def: def("noul", {
    kind: "function",
    syntax: "(instructions?: EntryType) => NoulQuestion",
    parameters: [def("instructions", entry, true)],
  }),
  binding: { kind: "import", spec: { name: "noul", from: "@typesafe-ai/sdk" } },
};

function makePrompt(): NormalizedQuestionsPrompt {
  return {
    style: "questions",
    id: "triage",
    providerId: "test",
    name: "triage",
    functionParameters: [
      def("ticket", {
        kind: "object",
        syntax: "Ticket",
        properties: [def("subject", text), def("body", text)],
      }),
    ],
    modelEditable: true,
    modelParameters: [],
    state: {
      def: def("state", entry),
      value: { kind: "primitive", value: "" },
    },
    stateEditable: true,
    questions: {
      def: def("questions", {
        kind: "record",
        syntax: "Questions",
        value: {
          ...def("", { kind: "opaque", syntax: "Question" }),
          catalogs: [
            {
              label: "Questions",
              groups: [
                { label: "Choice", factory: choice },
                { label: "Yes / no", factory: noul },
              ],
            },
          ],
        },
      }),
      value: {
        kind: "object",
        properties: {
          team: {
            kind: "functionCall",
            callee: "choice",
            args: [
              { kind: "primitive", value: "Which team?" },
              {
                kind: "object",
                properties: {
                  billing: { kind: "primitive", value: "Payments" },
                },
              },
            ],
          },
        },
      },
    },
    questionsEditable: true,
  };
}

/**
 * Two questions whose instructions sit in different entry modes: the first
 * structured, the second plain text.
 */
function makeMixedModePrompt(): NormalizedQuestionsPrompt {
  const base = makePrompt();
  return {
    ...base,
    questions: {
      ...base.questions,
      value: {
        kind: "object",
        properties: {
          structured: {
            kind: "functionCall",
            callee: "noul",
            args: [
              {
                kind: "object",
                properties: {
                  ask: { kind: "primitive", value: "Structured one" },
                },
              },
            ],
          },
          plain: {
            kind: "functionCall",
            callee: "noul",
            args: [{ kind: "primitive", value: "Plain one" }],
          },
        },
      },
    },
  };
}

/** Renders the questions editor for `prompt`, applying its updates locally. */
function Harness({ initial }: { initial: () => NormalizedQuestionsPrompt }) {
  const [prompt, setPrompt] = useState(initial);
  const [updates, setUpdates] = useState<NormalizedPromptUpdates[]>([]);
  return (
    <div>
      <PlaygroundEditor
        prompt={prompt}
        modelDefinition={null}
        onUpdate={u => {
          setUpdates(prev => [...prev, u]);
          if (u.style !== "questions") return;
          if (u.questions) {
            setPrompt(p => ({
              ...p,
              questions: { ...p.questions, value: u.questions ?? undefined },
            }));
          }
          if (u.state !== undefined) {
            setPrompt(p => ({
              ...p,
              state: { ...p.state, value: u.state ?? undefined },
            }));
          }
        }}
      />
      <pre data-testid="question-ids">
        {JSON.stringify(
          prompt.questions.value?.kind === "object"
            ? Object.keys(prompt.questions.value.properties)
            : [],
        )}
      </pre>
      <pre data-testid="state-value">{JSON.stringify(prompt.state.value)}</pre>
      <pre data-testid="update-count">{updates.length}</pre>
    </div>
  );
}

/** Renders the questions editor, applying its updates locally. */
export function QuestionsHarness() {
  return <Harness initial={makePrompt} />;
}

/** The same editor over two questions in different entry modes. */
export function MixedModeQuestionsHarness() {
  return <Harness initial={makeMixedModePrompt} />;
}
