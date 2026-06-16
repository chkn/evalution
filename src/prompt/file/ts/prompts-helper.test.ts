// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PropDefinition, PropValue } from "ts-proppy";
import { describe, expect, it } from "vitest";
import { LocalFileProvider } from "../../../file-provider-local.ts";
import { MemoryFileProvider } from "../../../file-provider-memory.ts";
import { isEditable } from "../../../shared/helpers.ts";
import { TSPromptFileType } from "./ts-prompt-file-type.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "__fixtures__");

function getValue(
  prompt: { extractedProps: { values?: Record<string, PropValue> } },
  name: string,
): PropValue {
  return prompt.extractedProps.values![name];
}

function getDef(
  prompt: { extractedProps: { definitions: PropDefinition[] } },
  name: string,
): PropDefinition {
  return prompt.extractedProps.definitions.find(d => d.name === name)!;
}

describe("TSPromptFileType — prompts() helper", () => {
  describe("parsing", () => {
    it("extracts each method of the helper object as a separate prompt", async () => {
      const filePath = path.join(fixturesDir, "prompts-helper.prompt.ts");
      const fileType = new TSPromptFileType(new LocalFileProvider());
      const parsed = await fileType.parsePrompts([filePath], "");

      expect(parsed).toHaveLength(2);
      expect(parsed.map(p => p.name).sort()).toEqual(["checkWeather", "greet"]);
    });

    it("extracts function parameters from helper methods", async () => {
      const filePath = path.join(fixturesDir, "prompts-helper.prompt.ts");
      const fileType = new TSPromptFileType(new LocalFileProvider());
      const parsed = await fileType.parsePrompts([filePath], "");

      const greet = parsed.find(p => p.name === "greet")!;
      expect(greet.functionParameters).toHaveLength(2);
      expect(greet.functionParameters[0]).toMatchObject({ name: "name" });
      expect(greet.functionParameters[1]).toMatchObject({
        name: "language",
        defaultValue: { kind: "primitive", value: "en" },
      });

      const weather = parsed.find(p => p.name === "checkWeather")!;
      expect(weather.functionParameters).toHaveLength(0);
    });

    it("extracts model, system, messages, and other props", async () => {
      const filePath = path.join(fixturesDir, "prompts-helper.prompt.ts");
      const fileType = new TSPromptFileType(new LocalFileProvider());
      const parsed = await fileType.parsePrompts([filePath], "");

      const weather = parsed.find(p => p.name === "checkWeather")!;
      expect(getValue(weather, "system")).toEqual({
        kind: "primitive",
        value: "You are a weather assistant",
      });
      expect(getValue(weather, "temperature")).toEqual({
        kind: "primitive",
        value: 0.7,
      });
      expect(getValue(weather, "maxTokens")).toEqual({
        kind: "primitive",
        value: 500,
      });

      const model = getValue(weather, "model");
      expect(model.kind).toBe("functionCall");
      if (model.kind === "functionCall") {
        expect(model.callee).toBe("openai");
        expect(model.args).toEqual([{ kind: "primitive", value: "gpt-4o" }]);
        // The callee resolves to a destructured parameter of the closure passed to prompts().
        expect(model.binding).toEqual({
          kind: "parameter",
          enclosingCall: {
            callee: "prompts",
            import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
          },
        });
      }
      expect(isEditable(model)).toBe(true);

      const messages = getValue(weather, "messages");
      expect(messages.kind).toBe("array");
    });

    it("uses method name as the prompt id suffix", async () => {
      const filePath = path.join(fixturesDir, "prompts-helper.prompt.ts");
      const fileType = new TSPromptFileType(new LocalFileProvider());
      const parsed = await fileType.parsePrompts([filePath], "");

      const weather = parsed.find(p => p.name === "checkWeather")!;
      expect(weather.id).toBe(`${filePath}#checkWeather`);
    });

    it("derives globalId from the module id argument and the method name", async () => {
      const filePath = "/virtual/with-id.prompt.ts";
      const source = `
import { prompts } from '@evalution/vercel-ai-sdk';
export default prompts({ id: 'orders' }, ({ openai }) => ({
  summarize() { return { model: openai('gpt-4o'), system: 'x', messages: [] }; },
  classify() { return { model: openai('gpt-4o'), system: 'y', messages: [] }; },
}));
`;
      const ft = new TSPromptFileType(
        new MemoryFileProvider({ [filePath]: source }),
      );
      const parsed = await ft.parsePrompts([filePath], "");

      expect(parsed.find(p => p.name === "summarize")!.globalId).toBe(
        "orders#summarize",
      );
      expect(parsed.find(p => p.name === "classify")!.globalId).toBe(
        "orders#classify",
      );
    });

    it('parses computed string-literal keys (e.g. ["myPrompt"])', async () => {
      const filePath = "/virtual/computed-key.prompt.ts";
      const source = `
import { prompts } from "@evalution/vercel-ai-sdk";
export default prompts(
  { id: "prompt2" },
  () => ({
    ["newPrompt"]: () => ({
    })
}))
`;
      const ft = new TSPromptFileType(
        new MemoryFileProvider({ [filePath]: source }),
      );
      const parsed = await ft.parsePrompts([filePath], "");

      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("newPrompt");
      expect(parsed[0].globalId).toBe("prompt2#newPrompt");
    });

    it("derives globalId when the id is passed as an object ({ id: '...' })", async () => {
      const filePath = "/virtual/object-id.prompt.ts";
      const source = `
import { prompts } from '@evalution/vercel-ai-sdk';
export default prompts({ id: 'orders' }, ({ openai }) => ({
  summarize() { return { model: openai('gpt-4o'), system: 'x', messages: [] }; },
  classify() { return { model: openai('gpt-4o'), system: 'y', messages: [] }; },
}));
`;
      const ft = new TSPromptFileType(
        new MemoryFileProvider({ [filePath]: source }),
      );
      const parsed = await ft.parsePrompts([filePath], "");

      expect(parsed).toHaveLength(2);
      expect(parsed.find(p => p.name === "summarize")!.globalId).toBe(
        "orders#summarize",
      );
      expect(parsed.find(p => p.name === "classify")!.globalId).toBe(
        "orders#classify",
      );
    });

    it('parses computed string-literal keys with object id form (e.g. ["myPrompt"])', async () => {
      const filePath = "/virtual/computed-key-obj.prompt.ts";
      const source = `
import { prompts } from "@evalution/vercel-ai-sdk";
export default prompts(
  { id: "prompt2" },
  () => ({
    ["newPrompt"]: () => ({
    })
}))
`;
      const ft = new TSPromptFileType(
        new MemoryFileProvider({ [filePath]: source }),
      );
      const parsed = await ft.parsePrompts([filePath], "");

      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("newPrompt");
      expect(parsed[0].globalId).toBe("prompt2#newPrompt");
    });
  });

  describe("editing", () => {
    const sample = `
import { prompts } from '@evalution/vercel-ai-sdk';

export default prompts({ id: 'helper' }, ({ openai }) => ({
  myPrompt() {
    return {
      model: openai('gpt-4o'),
      system: 'Old system',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
    };
  },
}));
`;

    it("updates a property of a helper-defined prompt", async () => {
      const filePath = "/virtual/helper.prompt.ts";
      const fp = new MemoryFileProvider({ [filePath]: sample });
      const ft = new TSPromptFileType(fp);
      const parsed = await ft.parsePrompts([filePath], "");

      await ft.updateProperty(filePath, getDef(parsed[0], "system"), {
        kind: "primitive",
        value: "New system",
      });

      const after = await fp.readFile(filePath);
      expect(after).toContain('"New system"');
      expect(after).not.toContain("Old system");
    });

    it("adds a property to a helper-defined prompt", async () => {
      const filePath = "/virtual/helper.prompt.ts";
      const fp = new MemoryFileProvider({ [filePath]: sample });
      const ft = new TSPromptFileType(fp);

      await ft.addProperty(filePath, "myPrompt", "maxTokens", {
        kind: "primitive",
        value: 1000,
      });

      const after = await fp.readFile(filePath);
      expect(after).toContain("maxTokens");
      expect(after).toContain("1000");
    });

    it("keeps the value editable without adding a top-level import when the callee is already destructured", async () => {
      const filePath = "/virtual/helper.prompt.ts";
      const fp = new MemoryFileProvider({ [filePath]: sample });
      const ft = new TSPromptFileType(fp);
      const parsed = await ft.parsePrompts([filePath], "");

      await ft.updateProperty(filePath, getDef(parsed[0], "model"), {
        kind: "functionCall",
        callee: "openai",
        args: [{ kind: "primitive", value: "gpt-4o-mini" }],
        binding: [
          {
            kind: "parameter",
            enclosingCall: {
              callee: "prompts",
              import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
            },
          },
          { kind: "import", spec: { name: "openai", from: "@ai-sdk/openai" } },
        ],
      });

      const after = await fp.readFile(filePath);
      expect(after).toContain('openai("gpt-4o-mini")');
      expect(after).not.toContain("import { openai } from '@ai-sdk/openai'");
    });

    it("preserves whitespace before the closing brace when augmenting the destructure", async () => {
      const filePath = "/virtual/helper.prompt.ts";
      const spaced = `
import { prompts } from '@evalution/vercel-ai-sdk';

export default prompts({ id: 'helper' }, ({ openai }) => ({
  myPrompt() {
    return {
      model: openai('gpt-4o'),
      system: 'hi',
      messages: [],
    };
  },
}));
`;
      const fp = new MemoryFileProvider({ [filePath]: spaced });
      const ft = new TSPromptFileType(fp);
      const parsed = await ft.parsePrompts([filePath], "");

      await ft.updateProperty(filePath, getDef(parsed[0], "model"), {
        kind: "functionCall",
        callee: "anthropic",
        args: [{ kind: "primitive", value: "claude-opus-4-7" }],
        binding: [
          {
            kind: "parameter",
            enclosingCall: {
              callee: "prompts",
              import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
            },
          },
          {
            kind: "import",
            spec: { name: "anthropic", from: "@ai-sdk/anthropic" },
          },
        ],
      });

      const after = await fp.readFile(filePath);
      expect(after).toContain("({ openai, anthropic })");
    });

    it("augments the destructure when switching to a new provider rather than adding a top-level import", async () => {
      const filePath = "/virtual/helper.prompt.ts";
      const fp = new MemoryFileProvider({ [filePath]: sample });
      const ft = new TSPromptFileType(fp);
      const parsed = await ft.parsePrompts([filePath], "");

      await ft.updateProperty(filePath, getDef(parsed[0], "model"), {
        kind: "functionCall",
        callee: "anthropic",
        args: [{ kind: "primitive", value: "claude-opus-4-7" }],
        binding: [
          {
            kind: "parameter",
            enclosingCall: {
              callee: "prompts",
              import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
            },
          },
          {
            kind: "import",
            spec: { name: "anthropic", from: "@ai-sdk/anthropic" },
          },
        ],
      });

      const after = await fp.readFile(filePath);
      expect(after).toContain('anthropic("claude-opus-4-7")');
      expect(after).toMatch(/\{\s*openai\s*,\s*anthropic\s*\}/);
      expect(after).not.toContain(
        "import { anthropic } from '@ai-sdk/anthropic'",
      );
    });

    it("renames a helper-defined prompt", async () => {
      const filePath = "/virtual/helper.prompt.ts";
      const fp = new MemoryFileProvider({ [filePath]: sample });
      const ft = new TSPromptFileType(fp);

      await ft.renamePrompt(filePath, "myPrompt", "renamed");

      const after = await fp.readFile(filePath);
      expect(after).toContain("renamed()");
      expect(after).not.toContain("myPrompt");
    });

    it("renames a helper-defined prompt to a non-identifier name using computed-property syntax", async () => {
      const filePath = "/virtual/helper.prompt.ts";
      const fp = new MemoryFileProvider({ [filePath]: sample });
      const ft = new TSPromptFileType(fp);

      await ft.renamePrompt(filePath, "myPrompt", "my-prompt");

      const after = await fp.readFile(filePath);
      expect(after).toContain('["my-prompt"]()');
      expect(after).not.toContain("myPrompt");
    });
  });

  describe("loadConfig", () => {
    // Inline the prompts() helper to avoid a real module resolution from a data URL.
    const inlined = `
const prompts = ({ id }, factory) => (providers = {}) => factory(providers);
export default prompts({ id: 'load' }, () => ({
  myPrompt(name) {
    return { model: 'openai/gpt-4o', system: 'hi ' + name, messages: [] };
  },
}));
`;

    it("invokes a helper-defined prompt and returns its config", async () => {
      const filePath = "/virtual/load.prompt.ts";
      const fp = new MemoryFileProvider({ [filePath]: inlined });
      const ft = new TSPromptFileType(fp);

      const config = await ft.loadConfig(filePath, "myPrompt", ["world"]);
      expect(config).toEqual({
        model: "openai/gpt-4o",
        system: "hi world",
        messages: [],
      });
    });
  });
});
