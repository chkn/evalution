// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeCatalogIndex,
  literalDefinition,
  type ValueCatalog,
} from "ts-proppy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFileProvider } from "../file-provider-local.ts";
import { TSPromptFileType } from "../prompt/file/ts/ts-prompt-file-type.ts";
import type {
  NormalizedPromptUpdates,
  ParsedPrompt,
  PropValue,
} from "../shared/types.ts";
import { GeminiInteractionsSDK } from "./gemini-interactions-sdk.ts";

// `@google/genai` is an optional peer dependency that the adapter imports
// lazily inside `executeConfig`. Mock it so the test exercises that
// dynamic-import path without depending on the real package.
const { createMock, GoogleGenAIMock } = vi.hoisted(() => {
  const createMock = vi.fn();
  return {
    createMock,
    GoogleGenAIMock: vi.fn(() => ({ interactions: { create: createMock } })),
  };
});
vi.mock("@google/genai", () => ({ GoogleGenAI: GoogleGenAIMock }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "../prompt/file/ts/__fixtures__");

function makeParsedPrompt(props: Record<string, PropValue>): ParsedPrompt {
  return {
    id: "test.prompt.ts#test",
    name: "test",
    functionParameters: [],
    extractedProps: {
      definitions: Object.keys(props).map(name => {
        if (name === "generation_config" && props[name].kind === "object") {
          return {
            name,
            type: {
              kind: "object" as const,
              syntax: "{}",
              properties: Object.keys(
                props[name].kind === "object"
                  ? (props[name] as any).properties
                  : {},
              ).map((subName: string) => ({
                name: subName,
                type: { kind: "primitive" as const, syntax: "any" },
                optional: true,
              })),
            },
            optional: true,
          };
        }
        return {
          name,
          type: { kind: "primitive" as const, syntax: "any" },
          optional: true,
        };
      }),
      values: props,
    },
  };
}

describe("GeminiInteractionsSDK", () => {
  const sdk = new GeminiInteractionsSDK();

  describe("normalizePrompt", () => {
    it("maps model, system_instruction, and input to normalized fields", () => {
      const prompt = makeParsedPrompt({
        model: { kind: "primitive", value: "gemini-3-flash-preview" },
        system_instruction: { kind: "primitive", value: "You are helpful." },
        input: {
          kind: "array",
          elements: [
            {
              kind: "object",
              properties: {
                type: { kind: "primitive", value: "user_input" },
                content: {
                  kind: "array",
                  elements: [
                    {
                      kind: "object",
                      properties: {
                        type: { kind: "primitive", value: "text" },
                        text: { kind: "primitive", value: "Hello" },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      });

      const normalized = sdk.normalizePrompt(prompt);

      expect(normalized.model).toEqual({
        kind: "object",
        properties: {
          model: { kind: "primitive", value: "gemini-3-flash-preview" },
        },
        displayValue: "gemini-3-flash-preview",
      });
      expect(normalized.system).toEqual({
        kind: "primitive",
        value: "You are helpful.",
      });
      expect(normalized.messages).toEqual([
        { role: "user", content: { kind: "primitive", value: "Hello" } },
      ]);
      expect(normalized.modelParameters).toEqual([]);
    });

    it("translates model_output step to assistant role", () => {
      const textContent = (text: string): PropValue => ({
        kind: "array",
        elements: [
          {
            kind: "object",
            properties: {
              type: { kind: "primitive", value: "text" },
              text: { kind: "primitive", value: text },
            },
          },
        ],
      });
      const prompt = makeParsedPrompt({
        model: { kind: "primitive", value: "gemini-3-flash-preview" },
        input: {
          kind: "array",
          elements: [
            {
              kind: "object",
              properties: {
                type: { kind: "primitive", value: "user_input" },
                content: textContent("Hi"),
              },
            },
            {
              kind: "object",
              properties: {
                type: { kind: "primitive", value: "model_output" },
                content: textContent("Hello!"),
              },
            },
          ],
        },
      });

      const normalized = sdk.normalizePrompt(prompt);

      expect(normalized.messages[0].role).toBe("user");
      expect(normalized.messages[1].role).toBe("assistant");
    });

    it("handles string input as single user message", () => {
      const prompt = makeParsedPrompt({
        model: { kind: "primitive", value: "gemini-3-flash-preview" },
        input: { kind: "primitive", value: "Tell me a joke." },
      });

      const normalized = sdk.normalizePrompt(prompt);
      expect(normalized.messages).toEqual([
        {
          role: "user",
          content: { kind: "primitive", value: "Tell me a joke." },
        },
      ]);
    });

    it("handles template string input", () => {
      const prompt = makeParsedPrompt({
        model: { kind: "primitive", value: "gemini-3-flash-preview" },
        input: {
          kind: "template",
          value: ["Tell me about ", { expr: "topic" }, ""],
        },
      });

      const normalized = sdk.normalizePrompt(prompt);
      expect(normalized.messages).toEqual([
        {
          role: "user",
          content: {
            kind: "template",
            value: ["Tell me about ", { expr: "topic" }, ""],
          },
        },
      ]);
    });

    it("exposes generation_config sub-properties as modelParameters", () => {
      const prompt = makeParsedPrompt({
        model: { kind: "primitive", value: "gemini-3-flash-preview" },
        input: { kind: "primitive", value: "Hello" },
        generation_config: {
          kind: "object",
          properties: {
            temperature: { kind: "primitive", value: 0.7 },
            max_output_tokens: { kind: "primitive", value: 500 },
          },
        },
      });

      const normalized = sdk.normalizePrompt(prompt);

      expect(normalized.modelParameters).toHaveLength(2);
      expect(normalized.modelParameters[0].def.name).toBe("temperature");
      expect(normalized.modelParameters[0].value).toEqual({
        kind: "primitive",
        value: 0.7,
      });
      expect(normalized.modelParameters[1].def.name).toBe("max_output_tokens");
    });

    it("preserves prompt metadata", () => {
      const prompt = makeParsedPrompt({
        model: { kind: "primitive", value: "gemini-3-flash-preview" },
        input: { kind: "primitive", value: "Hi" },
      });
      prompt.metadata = { relativeFilePath: "prompts/test.prompt.ts" };
      prompt.treePath = ["prompts", "test.prompt.ts"];

      const normalized = sdk.normalizePrompt(prompt);

      expect(normalized.metadata).toEqual({
        relativeFilePath: "prompts/test.prompt.ts",
      });
      expect(normalized.treePath).toEqual(["prompts", "test.prompt.ts"]);
    });

    it("handles content objects with type field", () => {
      const prompt = makeParsedPrompt({
        model: { kind: "primitive", value: "gemini-3-flash-preview" },
        input: {
          kind: "array",
          elements: [
            {
              kind: "object",
              properties: {
                type: { kind: "primitive", value: "text" },
                text: { kind: "primitive", value: "Describe the image." },
              },
            },
          ],
        },
      });

      const normalized = sdk.normalizePrompt(prompt);
      expect(normalized.messages).toEqual([
        {
          role: "user",
          content: { kind: "primitive", value: "Describe the image." },
        },
      ]);
    });
  });

  describe("denormalizeUpdates", () => {
    it("maps model, system, messages to SDK property names", () => {
      const updates: NormalizedPromptUpdates = {
        style: "chat",
        model: {
          kind: "object",
          properties: {
            model: { kind: "primitive", value: "gemini-2.5-pro" },
          },
        },
        system: { kind: "primitive", value: "Be concise." },
        messages: [
          { role: "user", content: { kind: "primitive", value: "Hello" } },
          {
            role: "assistant",
            content: { kind: "primitive", value: "Hi there!" },
          },
        ],
      };

      const raw = sdk.denormalizeUpdates(updates, {});

      expect(raw.model).toEqual({
        kind: "primitive",
        value: "gemini-2.5-pro",
      });
      expect(raw.system_instruction).toEqual({
        kind: "primitive",
        value: "Be concise.",
      });
      expect(raw.input).toBeDefined();

      // Check assistant → model_output step translation
      const inputArray = raw.input as PropValue & { kind: "array" };
      expect(inputArray.kind).toBe("array");
      const firstStep = inputArray.elements[0] as PropValue & {
        kind: "object";
      };
      expect(firstStep.properties.type).toEqual({
        kind: "primitive",
        value: "user_input",
      });
      const secondStep = inputArray.elements[1] as PropValue & {
        kind: "object";
      };
      expect(secondStep.properties.type).toEqual({
        kind: "primitive",
        value: "model_output",
      });
      // Content is wrapped in [{type: 'text', text: <content>}]
      const secondContent = secondStep.properties.content as PropValue & {
        kind: "array";
      };
      const secondText = secondContent.elements[0] as PropValue & {
        kind: "object";
      };
      expect(secondText.properties.text).toEqual({
        kind: "primitive",
        value: "Hi there!",
      });
    });

    it("nests modelParameter updates under generation_config", () => {
      const currentValues = {
        generation_config: {
          kind: "object" as const,
          properties: {
            temperature: { kind: "primitive" as const, value: 0.7 },
            max_output_tokens: { kind: "primitive" as const, value: 500 },
          },
        },
      };
      const updates: NormalizedPromptUpdates = {
        style: "chat",
        modelParameters: {
          temperature: { kind: "primitive", value: 0.5 },
          max_output_tokens: null,
        },
      };

      const raw = sdk.denormalizeUpdates(updates, currentValues);

      expect(raw.generation_config).toEqual({
        kind: "object",
        properties: { temperature: { kind: "primitive", value: 0.5 } },
      });
    });

    it("removes generation_config when all params are deleted", () => {
      const currentValues = {
        generation_config: {
          kind: "object" as const,
          properties: {
            temperature: { kind: "primitive" as const, value: 0.7 },
          },
        },
      };
      const raw = sdk.denormalizeUpdates(
        { style: "chat", modelParameters: { temperature: null } },
        currentValues,
      );
      expect(raw.generation_config).toBeNull();
    });

    it("creates generation_config from scratch when none exists", () => {
      const raw = sdk.denormalizeUpdates(
        {
          style: "chat",
          modelParameters: { temperature: { kind: "primitive", value: 0.9 } },
        },
        {},
      );
      expect(raw.generation_config).toEqual({
        kind: "object",
        properties: { temperature: { kind: "primitive", value: 0.9 } },
      });
    });

    it("handles null values for removal", () => {
      const raw = sdk.denormalizeUpdates({ style: "chat", system: null });
      expect(raw.system_instruction).toBeNull();
    });

    it("only includes keys that are present in updates", () => {
      const raw = sdk.denormalizeUpdates(
        {
          style: "chat",
          model: {
            kind: "object",
            properties: { model: { kind: "primitive", value: "test" } },
          },
        },
        {},
      );
      expect(Object.keys(raw)).toEqual(["model"]);
    });
  });

  describe("executeConfig", () => {
    beforeEach(() => {
      createMock.mockReset();
      GoogleGenAIMock.mockClear();
    });

    it("lazily imports `@google/genai` and creates a non-persisted interaction", async () => {
      const config = {
        model: "gemini-3-flash-preview",
        input: "hi",
      } as Parameters<typeof sdk.executeConfig>[0];
      await sdk.executeConfig(config);
      expect(GoogleGenAIMock).toHaveBeenCalledTimes(1);
      expect(createMock).toHaveBeenCalledWith({ ...config, store: false });
    });
  });

  describe("model variants", () => {
    const text = (value: string): PropValue => ({ kind: "primitive", value });
    const agent: PropValue = {
      kind: "object",
      properties: { agent: text("deep-research-preview-04-2026") },
    };

    it("normalizes an agent config into an agent fragment, with agent settings", () => {
      const prompt = makeParsedPrompt({
        agent: text("deep-research-preview-04-2026"),
        agent_config: {
          kind: "object",
          properties: { thinking_summaries: text("auto") },
        },
      });
      prompt.extractedProps.definitions = [
        ...prompt.extractedProps.definitions.filter(
          d => d.name !== "agent_config",
        ),
        {
          name: "agent_config",
          optional: true,
          type: {
            kind: "object",
            syntax: "DeepResearchAgentConfig",
            properties: [
              {
                name: "thinking_summaries",
                optional: true,
                type: { kind: "primitive", syntax: "string" },
              },
            ],
          },
        },
      ];
      const normalized = sdk.normalizePrompt(prompt);
      expect(normalized.model).toMatchObject({
        properties: { agent: text("deep-research-preview-04-2026") },
      });
      expect(normalized.modelParameters.map(p => p.def.name)).toEqual([
        "thinking_summaries",
      ]);
    });

    it("switching a model config to an agent drops the model and its generation_config", () => {
      const raw = sdk.denormalizeUpdates(
        { style: "chat", model: agent },
        {
          model: text("gemini-3.5-flash"),
          generation_config: {
            kind: "object",
            properties: { temperature: { kind: "primitive", value: 0.2 } },
          },
        },
      );
      expect(raw).toEqual({
        agent: text("deep-research-preview-04-2026"),
        model: null,
        generation_config: null,
      });
    });

    it("keeps the variant's own settings when the ID changes within it", () => {
      const raw = sdk.denormalizeUpdates(
        {
          style: "chat",
          model: {
            kind: "object",
            properties: { model: text("gemini-2.5-pro") },
          },
        },
        {
          model: text("gemini-3.5-flash"),
          generation_config: { kind: "object", properties: {} },
        },
      );
      expect(raw).toEqual({ model: text("gemini-2.5-pro") });
    });

    it("writes settings into the agent's config for an agent", () => {
      const raw = sdk.denormalizeUpdates(
        {
          style: "chat",
          modelParameters: { thinking_summaries: text("none") },
        },
        { agent: text("deep-research-preview-04-2026") },
      );
      expect(raw).toEqual({
        agent_config: {
          kind: "object",
          properties: { thinking_summaries: text("none") },
        },
      });
    });
  });

  describe("getModelDefinition", () => {
    it("offers Models and Agents catalogs of config fragments", async () => {
      const def = await sdk.getModelDefinition({});
      const [models, agents] = def.catalogs!;
      expect(models.label).toBe("Models");
      expect(agents.label).toBe("Agents");

      const presets = (catalog: ValueCatalog) =>
        catalog.groups.flatMap(g => g.presets ?? []);
      expect(
        presets(models).find(p => p.label === "Gemini 3.7 Flash")?.value,
      ).toMatchObject({
        kind: "object",
        properties: { model: { kind: "primitive", value: "gemini-3.7-flash" } },
      });
      expect(
        presets(agents).find(p => p.label === "Deep Research Preview")?.value,
      ).toMatchObject({
        properties: {
          agent: { kind: "primitive", value: "deep-research-preview-04-2026" },
        },
      });
    });

    it("narrows each catalog's free-form entry to its own variant", async () => {
      const def = await sdk.getModelDefinition({});
      const [models, agents] = def.catalogs!;
      const agentValue: PropValue = {
        kind: "object",
        properties: { agent: { kind: "primitive", value: "my-agent" } },
      };
      expect(literalDefinition(models, def)?.type).toMatchObject({
        properties: [{ name: "model" }],
      });
      expect(literalDefinition(agents, def)?.type).toMatchObject({
        properties: [{ name: "agent" }],
      });
      expect(activeCatalogIndex(def.catalogs!, def, agentValue)).toBe(1);
    });

    it("reads each variant's ID type from the installed SDK when probed", async () => {
      const def = await sdk.getModelDefinition({
        model: {
          name: "model",
          optional: false,
          type: {
            kind: "union",
            syntax: "",
            types: [
              {
                kind: "object",
                syntax: "",
                properties: [
                  {
                    name: "model",
                    optional: false,
                    type: {
                      kind: "union",
                      syntax: "Model_2",
                      types: [
                        { kind: "constant", syntax: "'a'", value: "a" },
                        {
                          kind: "primitive",
                          syntax: "string & {}",
                          base: "string",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      });
      const literal = literalDefinition(def.catalogs![0], def)!;
      expect(literal.type).toMatchObject({
        properties: [{ type: { syntax: "Model_2" } }],
      });
    });
  });

  describe("file parsing integration", () => {
    it("normalizes system_instruction built from string concatenation as an editable primitive", async () => {
      const fileType = new TSPromptFileType(new LocalFileProvider());
      const fixturePath = path.join(
        fixturesDir,
        "gemini-concat-system.prompt.ts",
      );
      const [parsed] = await fileType.parsePrompts([fixturePath], fixturesDir);

      const normalized = sdk.normalizePrompt(parsed);

      // system_instruction is a multi-part string literal concatenation —
      // it must parse to a primitive string, not a raw expression
      expect(normalized.system).toEqual({
        kind: "primitive",
        value:
          "You are a magic oracle for kids, a wise and playful entity that tries to answer any question " +
          "in a way that is age appropriate and easy for them to understand. Use simple language, fun examples, " +
          "and a friendly tone to make your answers engaging and informative.",
      });
      expect(normalized.systemEditable).toBe(true);
    });
  });
});
