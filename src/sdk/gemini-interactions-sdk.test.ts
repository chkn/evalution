// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalFileProvider } from "../file-provider.ts";
import { TSPromptFileType } from "../prompt/file/ts/ts-prompt-file-type.ts";
import type {
  NormalizedPromptUpdates,
  ParsedPrompt,
  PropValue,
} from "../shared/types.ts";
import { GeminiInteractionsSDK } from "./gemini-interactions-sdk.ts";

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
          key: { kind: "primitive", value: "model" },
          value: { kind: "primitive", value: "gemini-3-flash-preview" },
        },
        displayValue: '"gemini-3-flash-preview"',
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
        model: {
          kind: "object",
          properties: {
            key: { kind: "primitive", value: "model" },
            value: { kind: "primitive", value: "gemini-2.5-pro" },
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
        { modelParameters: { temperature: null } },
        currentValues,
      );
      expect(raw.generation_config).toBeNull();
    });

    it("creates generation_config from scratch when none exists", () => {
      const raw = sdk.denormalizeUpdates(
        { modelParameters: { temperature: { kind: "primitive", value: 0.9 } } },
        {},
      );
      expect(raw.generation_config).toEqual({
        kind: "object",
        properties: { temperature: { kind: "primitive", value: 0.9 } },
      });
    });

    it("handles null values for removal", () => {
      const raw = sdk.denormalizeUpdates({ system: null });
      expect(raw.system_instruction).toBeNull();
    });

    it("only includes keys that are present in updates", () => {
      const raw = sdk.denormalizeUpdates(
        {
          model: {
            kind: "object",
            properties: {
              key: { kind: "primitive", value: "model" },
              value: { kind: "primitive", value: "test" },
            },
          },
        },
        {},
      );
      expect(Object.keys(raw)).toEqual(["model"]);
    });
  });

  describe("getModelCatalog", () => {
    it("returns a non-empty model list", async () => {
      const catalog = await sdk.getModelCatalog();
      expect(catalog.models.length).toBeGreaterThan(0);
      expect(catalog.models[0].id).toContain("gemini");
      expect(catalog.models[0].values.model).toBeDefined();
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
