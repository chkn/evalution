// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalFileProvider } from "../../../file-provider-local.ts";
import { isEditable } from "../../../shared/helpers.ts";
import type { PropValue } from "../../../shared/types.ts";
import { TSPromptFileType } from "./ts-prompt-file-type.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixturesDir = path.join(__dirname, "__fixtures__");

async function loadFixtures(...fileNames: string[]) {
  const paths = fileNames.map(f => path.join(fixturesDir, f));
  const fileType = new TSPromptFileType(new LocalFileProvider());
  return { paths, fileType };
}

/** Helper to look up a value by name from extractedProps */
function getValue(
  prompt: { extractedProps: { values?: Record<string, PropValue> } },
  name: string,
): PropValue {
  return prompt.extractedProps.values![name];
}

/** Helper to look up a definition by name from extractedProps */
function getDef(
  prompt: {
    extractedProps: {
      definitions: {
        name: string;
        valueSpan?: { start: number; end: number };
      }[];
    };
  },
  name: string,
) {
  return prompt.extractedProps.definitions.find(d => d.name === name)!;
}

describe("PromptParser", () => {
  describe("basic parsing", () => {
    it("should parse file with single exported function (no parameters)", async () => {
      const { paths, fileType } = await loadFixtures("basic.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe("checkWeather");
      expect(prompts[0].functionParameters).toHaveLength(0);
      expect(getValue(prompts[0], "model")).toBeDefined();
      expect(getValue(prompts[0], "system")).toBeDefined();
      expect(getValue(prompts[0], "messages")).toBeDefined();
    });

    it("should parse file with multiple exported functions", async () => {
      const { paths, fileType } = await loadFixtures(
        "multiple-exports.prompt.ts",
      );
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(prompts).toHaveLength(2);
      expect(prompts[0].name).toBe("promptOne");
      expect(prompts[1].name).toBe("promptTwo");
    });

    it("should extract function names as prompt names", async () => {
      const { paths, fileType } = await loadFixtures("basic.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(prompts[0].name).toBe("checkWeather");
      expect(prompts[0].id).toBe(`${paths[0]}#checkWeather`);
    });
  });

  describe("function parameters", () => {
    it("should parse function parameters (name, type, default value)", async () => {
      const { paths, fileType } = await loadFixtures("parameterized.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(prompts[0].functionParameters).toHaveLength(2);
      expect(prompts[0].functionParameters[0]).toEqual({
        name: "name",
        type: { kind: "primitive", syntax: "string" },
        optional: false,
      });
      expect(prompts[0].functionParameters[1]).toEqual({
        name: "language",
        type: { kind: "primitive", syntax: "string" },
        optional: true,
        defaultValue: { kind: "primitive", value: "en" },
      });
    });
  });

  describe("property parsing", () => {
    it("should parse string literal parameters as PropValue", async () => {
      const { paths, fileType } = await loadFixtures("basic.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const system = getValue(prompts[0], "system");
      expect(system).toEqual({
        kind: "primitive",
        value: "You are a weather assistant",
      });
      expect(isEditable(system)).toBe(true);
    });

    it("should parse numeric parameters as PropValue", async () => {
      const { paths, fileType } = await loadFixtures("basic.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const temperature = getValue(prompts[0], "temperature");
      expect(temperature).toEqual({ kind: "primitive", value: 0.7 });
      expect(isEditable(temperature)).toBe(true);

      const maxTokens = getValue(prompts[0], "maxTokens");
      expect(maxTokens).toEqual({ kind: "primitive", value: 500 });
    });

    it("should parse array parameters (messages) as PropValue", async () => {
      const { paths, fileType } = await loadFixtures("basic.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const value = getValue(prompts[0], "messages");
      expect(value.kind).toBe("array");
      if (value.kind === "array") {
        expect(value.elements).toHaveLength(1);
        expect(value.elements[0]).toEqual({
          kind: "object",
          properties: {
            role: { kind: "primitive", value: "user" },
            content: { kind: "primitive", value: "What is the weather in SF?" },
          },
        });
      }
    });
  });

  describe("template values", () => {
    it("should parse template literals as template PropValue", async () => {
      const { paths, fileType } = await loadFixtures("parameterized.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const system = getValue(prompts[0], "system");
      expect(system).toEqual({
        kind: "template",
        value: [
          "You are a friendly assistant speaking in ",
          { expr: "language" },
          "",
        ],
      });
      expect(isEditable(system)).toBe(true);

      const msgValue = getValue(prompts[0], "messages");
      expect(msgValue.kind).toBe("array");
      if (msgValue.kind === "array") {
        const content = (
          msgValue.elements[0] as Extract<PropValue, { kind: "object" }>
        ).properties.content;
        expect(content).toEqual({
          kind: "template",
          value: ["Hello, my name is ", { expr: "name" }, ""],
        });
      }
    });

    it("should handle object parameter with field interpolation", async () => {
      const { paths, fileType } = await loadFixtures("object-param.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe("userProfile");

      expect(prompts[0].functionParameters).toHaveLength(1);
      expect(prompts[0].functionParameters[0].name).toBe("config");
      expect(prompts[0].functionParameters[0].type).toMatchObject({
        kind: "object",
        syntax: "{ name: string; age: number }",
      });

      const system = getValue(prompts[0], "system");
      expect(system).toEqual({
        kind: "template",
        value: [
          "User is ",
          { expr: "config.name" },
          ", age ",
          { expr: "config.age" },
          "",
        ],
      });

      const msgValue = getValue(prompts[0], "messages");
      if (msgValue.kind === "array") {
        const content = (
          msgValue.elements[0] as Extract<PropValue, { kind: "object" }>
        ).properties.content;
        expect(content).toEqual({
          kind: "template",
          value: ["Tell me about ", { expr: "config.name" }, ""],
        });
      }
    });

    it("should handle destructured object parameters", async () => {
      const { paths, fileType } = await loadFixtures(
        "destructured-param.prompt.ts",
      );
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe("userGreeting");
      expect(prompts[0].functionParameters.length).toBeGreaterThan(0);

      const sysValue = getValue(prompts[0], "system");
      expect(sysValue.kind).toBe("template");
      if (sysValue.kind === "template") {
        expect(
          sysValue.value.some(s => typeof s !== "string" && s.expr === "name"),
        ).toBe(true);
        expect(
          sysValue.value.some(s => typeof s !== "string" && s.expr === "age"),
        ).toBe(true);
      }
    });

    it("should handle destructured parameters with default values", async () => {
      const { paths, fileType } = await loadFixtures(
        "destructured-defaults.prompt.ts",
      );
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe("customGreeting");
      expect(prompts[0].functionParameters).toHaveLength(2);

      const nameParam = prompts[0].functionParameters.find(
        p => p.name === "name",
      );
      expect(nameParam).toBeDefined();
      expect(nameParam!.defaultValue).toBeUndefined();

      const greetingParam = prompts[0].functionParameters.find(
        p => p.name === "greeting",
      );
      expect(greetingParam).toBeDefined();
      expect(greetingParam!.defaultValue).toEqual({
        kind: "primitive",
        value: "Hello",
      });

      const sysValue = getValue(prompts[0], "system");
      expect(sysValue.kind).toBe("template");
      if (sysValue.kind === "template") {
        expect(
          sysValue.value.some(
            s => typeof s !== "string" && s.expr === "greeting",
          ),
        ).toBe(true);
        expect(
          sysValue.value.some(s => typeof s !== "string" && s.expr === "name"),
        ).toBe(true);
      }
    });
  });

  describe("model parameter", () => {
    it("should parse model parameter - string format", async () => {
      const { paths, fileType } = await loadFixtures("basic.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const model = getValue(prompts[0], "model");
      expect(model).toEqual({ kind: "primitive", value: "openai/gpt-4o" });
      expect(isEditable(model)).toBe(true);
    });

    it("should parse model parameter - function call format", async () => {
      const { paths, fileType } = await loadFixtures(
        "function-model.prompt.ts",
      );
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const model = getValue(prompts[0], "model");
      expect(model.kind).toBe("functionCall");
      if (model.kind === "functionCall") {
        expect(model.callee).toBe("openai");
        expect(model.args).toEqual([{ kind: "primitive", value: "gpt-4o" }]);
        expect(model.binding).toEqual({
          kind: "import",
          spec: { name: "openai", from: "@ai-sdk/openai" },
        });
      }
      expect(isEditable(model)).toBe(true);
    });
  });

  describe("source information", () => {
    it("should extract source spans for all parameters", async () => {
      const { paths, fileType } = await loadFixtures("basic.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const systemDef = getDef(prompts[0], "system");
      expect(systemDef.valueSpan).toBeDefined();
      expect(systemDef.valueSpan!.start).toBeGreaterThan(0);
      expect(systemDef.valueSpan!.end).toBeGreaterThan(
        systemDef.valueSpan!.start as number,
      );
    });
  });

  describe("editability", () => {
    it("should identify editable vs read-only parameters", async () => {
      const { paths, fileType } = await loadFixtures("basic.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(isEditable(getValue(prompts[0], "system"))).toBe(true);
      expect(isEditable(getValue(prompts[0], "temperature"))).toBe(true);
    });

    it("should handle dynamic/computed values (mark as read-only)", async () => {
      const { paths, fileType } = await loadFixtures(
        "dynamic-values.prompt.ts",
      );
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const system = getValue(prompts[0], "system");
      expect(isEditable(system)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle files with syntax errors gracefully", async () => {
      const { paths, fileType } = await loadFixtures(
        "invalid-syntax.prompt.ts",
      );
      const prompts = await fileType.parsePrompts([paths[0]], "");

      expect(Array.isArray(prompts)).toBe(true);
    });

    it("should handle nested object structures in parameters", async () => {
      const { paths, fileType } = await loadFixtures("complex.prompt.ts");
      const prompts = await fileType.parsePrompts([paths[0]], "");

      const msgValue = getValue(prompts[0], "messages");
      expect(msgValue.kind).toBe("array");
      if (msgValue.kind === "array") {
        expect(msgValue.elements.length).toBeGreaterThan(0);
        const first = msgValue.elements[0];
        expect(first.kind).toBe("object");
        if (first.kind === "object") {
          expect(first.properties).toHaveProperty("role");
          expect(first.properties).toHaveProperty("content");
        }
      }
    });
  });

  describe("parseAll", () => {
    it("should parse all files in the program", async () => {
      const { paths, fileType } = await loadFixtures(
        "basic.prompt.ts",
        "function-model.prompt.ts",
      );
      const allPrompts = await fileType.parsePrompts(paths, "");

      expect(allPrompts.length).toBeGreaterThanOrEqual(2);
    });
  });
});
