// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeCatalogIndex,
  defaultCall,
  findFactory,
  findPreset,
  getDiscriminatedUnionInfo,
  type PropValue,
  setCallArgument,
} from "ts-proppy";
import { describe, expect, it } from "vitest";
import { MemoryFileProvider } from "../../file-provider-memory.ts";
import { FilePromptProvider } from "../../prompt/file/file-prompt-provider.ts";
import { isEditable } from "../../shared/helpers.ts";
import type {
  NormalizedPrompt,
  NormalizedQuestionsPrompt,
} from "../../shared/types.ts";
import { VERCEL_EVALUATION_FALLBACK } from "./evaluation-fallback.ts";
import { VercelAISDK } from "./index.ts";
import { vercelEvaluationModelDefinition } from "./model-definition.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../../prompt/file/ts/__fixtures__");
const FIXTURE = "vercel-evaluate.prompt.ts";

/**
 * A provider over an in-memory copy of the fixture, rooted at the real
 * fixtures directory so project probes resolve against the installed `ai`.
 */
function fixtureProvider() {
  const filePath = path.join(fixturesDir, FIXTURE);
  const fileProvider = new MemoryFileProvider({
    [filePath]: readFileSync(filePath, "utf8"),
  });
  return new FilePromptProvider({
    rootDir: fixturesDir,
    fileProvider,
    includePatterns: [FIXTURE],
    playgroundIncludePatterns: [],
    sdk: new VercelAISDK(),
  });
}

async function prompt(name: string): Promise<NormalizedPrompt> {
  return (await fixtureProvider().getPrompt(`${FIXTURE}#${name}`))!;
}

async function questionsPrompt(
  name: string,
): Promise<NormalizedQuestionsPrompt> {
  const p = await prompt(name);
  if (p.style !== "questions") throw new Error(`${name} is ${p.style}`);
  return p;
}

describe("normalizing evaluation prompts", () => {
  it("puts a config that asks questions in the questions style", async () => {
    const p = await questionsPrompt("triage");
    expect(p.questionsEditable).toBe(true);
    expect(p.stateEditable).toBe(true);
    expect(p.state.value).toEqual({
      kind: "object",
      properties: { ticket: { kind: "reference", path: ["ticket"] } },
    });
    const questions = (p.questions.value as { properties: object }).properties;
    expect(Object.keys(questions)).toEqual([
      "department",
      "severity",
      "requestsRefund",
    ]);
  });

  it("keeps a generateText config in the chat style beside it", async () => {
    expect((await prompt("reply")).style).toBe("chat");
  });

  it("types the questions as a record of the SDK's question union", async () => {
    const { questions } = await questionsPrompt("triage");
    expect(questions.def.type.kind).toBe("record");
    if (questions.def.type.kind !== "record") return;
    const union = getDiscriminatedUnionInfo(questions.def.type.value.type);
    expect(union?.discriminator).toBe("type");
    expect(union?.cases.map(c => c.discriminatorValue)).toEqual([
      "choice",
      "score",
      "boolean",
    ]);
  });

  it("binds a provider's evaluationModel call through its import, so it's editable", async () => {
    const { model } = await questionsPrompt("triage");
    expect(model).toMatchObject({
      kind: "functionCall",
      callee: "typeSafeAi.evaluationModel",
      binding: {
        kind: "import",
        spec: { name: "typeSafeAi", from: "@ai-sdk/typesafe-ai" },
      },
    });
    expect(isEditable(model!)).toBe(true);
  });

  it("binds one through the helper's destructure, too", async () => {
    const { model } = await questionsPrompt("computed");
    expect(model).toMatchObject({
      callee: "openai.evaluationModel",
      binding: { kind: "parameter" },
    });
    expect(isEditable(model!)).toBe(true);
  });

  it("recognizes computed questions as an evaluation, but not as editable", async () => {
    const { questions } = await questionsPrompt("computed");
    // `buildQuestions()`: a call nothing binds, so there is no literal to edit.
    expect(isEditable(questions.value!)).toBe(false);
  });

  it("uses the snapshot when the probes can't be resolved", () => {
    const sdk = new VercelAISDK();
    const p = sdk.normalizePrompt(
      {
        id: "x",
        name: "x",
        functionParameters: [],
        extractedProps: {
          definitions: [
            {
              name: "state",
              type: { kind: "opaque", syntax: "" },
              optional: false,
            },
            {
              name: "questions",
              type: { kind: "opaque", syntax: "" },
              optional: false,
            },
          ],
          values: {},
        },
      } as any,
      undefined,
      {},
    ) as NormalizedQuestionsPrompt;
    expect(p.questions.def.type).toEqual(
      (VERCEL_EVALUATION_FALLBACK.evaluationQuestions as any).type,
    );
  });
});

describe("the evaluation model row", () => {
  it("is asked for by style, beside the chat model row", async () => {
    const provider = fixtureProvider();
    const chat = await provider.getModelDefinition("chat");
    const evaluation = await provider.getModelDefinition("questions");
    expect(chat.type.syntax).toBe("LanguageModel");
    expect(evaluation.type.syntax).toBe("EvaluationModel");
  });

  it("offers each installed provider's evaluationModel, TypeSafe first", async () => {
    const def = await fixtureProvider().getModelDefinition("questions");
    const groups = def.catalogs![0].groups;
    expect(groups[0].label).toBe("TypeSafe");
    expect(groups.map(g => g.label)).toEqual(
      expect.arrayContaining(["OpenAI", "Anthropic", "Google"]),
    );
    expect(
      groups.every(g => g.factory?.def.name.endsWith(".evaluationModel")),
    ).toBe(true);
  });

  it("shows a prompt's model as the preset it is", async () => {
    const def = await fixtureProvider().getModelDefinition("questions");
    const { model } = await questionsPrompt("triage");
    expect(findPreset(def.catalogs!, model)?.preset.label).toBe("Jev (latest)");
  });

  it("shows a string model under the Gateway catalog", async () => {
    const def = await fixtureProvider().getModelDefinition("questions");
    const { model } = await questionsPrompt("gateway");
    expect(activeCatalogIndex(def.catalogs!, def, model)).toBe(1);
  });
});

describe("evaluation edits round-trip through the file", () => {
  const filePath = "/project/triage.prompt.ts";
  const source = `import { prompts } from '@evalution/vercel-ai-sdk';

export default prompts({ id: 'triage' }, () => ({
  triage: (message: string) => ({
    model: 'jev-latest',
    state: message,
    questions: {
      spam: { type: 'boolean', instructions: 'Is this spam?' },
    },
  }),
}));
`;

  async function edit(updates: {
    model?: PropValue;
    state?: PropValue;
    questions?: PropValue;
  }) {
    const fileProvider = new MemoryFileProvider({ [filePath]: source });
    const provider = new FilePromptProvider({
      rootDir: "/project",
      fileProvider,
      sdk: new VercelAISDK(),
    });
    const updated = (
      await provider.updatePromptProperties("triage.prompt.ts#triage", {
        style: "questions",
        ...updates,
      })
    ).prompt as NormalizedQuestionsPrompt;
    return { updated, text: await fileProvider.readFile(filePath) };
  }

  const def = vercelEvaluationModelDefinition({});
  const typeSafe = def.catalogs![0].groups.find(g => g.label === "TypeSafe")!;

  it("writes a provider preset as a member call, bound through the helper", async () => {
    const preset = typeSafe.presets![0];
    const { updated, text } = await edit({ model: preset.value });
    expect(text).toContain(`model: typeSafeAi.evaluationModel("jev-latest")`);
    expect(text).toContain("({ typeSafeAi }) =>");
    expect(updated.style).toBe("questions");
    expect(findPreset(def.catalogs!, updated.model)?.preset).toBe(preset);
    expect(isEditable(updated.model!)).toBe(true);
  });

  it("writes a custom model through the provider's evaluationModel", async () => {
    const factory = typeSafe.factory!;
    const params =
      factory.def.type.kind === "function" ? factory.def.type.parameters : [];
    const custom = setCallArgument(defaultCall(factory), params, 0, {
      kind: "primitive",
      value: "jev-2026-09-01",
    });
    const { updated, text } = await edit({ model: custom });
    expect(text).toContain(`typeSafeAi.evaluationModel("jev-2026-09-01")`);
    expect(findFactory(def.catalogs!, updated.model)?.factory.def.name).toBe(
      "typeSafeAi.evaluationModel",
    );
  });

  it("writes questions as object literals", async () => {
    const questions: PropValue = {
      kind: "object",
      properties: {
        spam: {
          kind: "object",
          properties: {
            type: { kind: "primitive", value: "boolean" },
            instructions: { kind: "primitive", value: "Is this spam?" },
          },
        },
        severity: {
          kind: "object",
          properties: {
            type: { kind: "primitive", value: "score" },
            instructions: { kind: "primitive", value: "How severe?" },
            criteria: {
              kind: "array",
              elements: [
                { kind: "primitive", value: "Low" },
                { kind: "primitive", value: "High" },
              ],
            },
          },
        },
      },
    };
    const { updated, text } = await edit({ questions });
    expect(text).toContain(
      `severity: { type: "score", instructions: "How severe?", criteria: ["Low", "High"] }`,
    );
    expect(
      Object.keys(
        (updated.questions.value as { properties: object }).properties,
      ),
    ).toEqual(["spam", "severity"]);
  });
});
