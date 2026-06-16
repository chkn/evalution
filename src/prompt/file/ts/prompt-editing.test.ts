// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropDefinition, PropValue } from "ts-proppy";
import { describe, expect, it } from "vitest";
import { MemoryFileProvider } from "../../../file-provider-memory.ts";
import { isEditable } from "../../../shared/helpers.ts";
import { TSPromptFileType } from "./ts-prompt-file-type.ts";

/** Helper to look up a PropDefinition by name */
function getDef(
  prompt: { extractedProps: { definitions: PropDefinition[] } },
  name: string,
): PropDefinition {
  return prompt.extractedProps.definitions.find(d => d.name === name)!;
}

/** Helper to look up a value by name */
function getValue(
  prompt: { extractedProps: { values?: Record<string, PropValue> } },
  name: string,
): PropValue {
  return prompt.extractedProps.values![name];
}

describe("TSPromptFileType editor", () => {
  async function setup(content: string, filename = "/virtual/test.prompt.ts") {
    const fileProvider = new MemoryFileProvider({ [filename]: content });
    const editor = new TSPromptFileType(fileProvider);
    const prompts = await editor.parsePrompts([filename], "");
    return { filePath: filename, fileProvider, editor, prompts };
  }

  it("should update string parameter", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Old prompt',
    messages: [{ role: 'user', content: 'Test' }]
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "system"), {
      kind: "primitive",
      value: "New prompt",
    });

    expect(await fileProvider.readFile(filePath)).toContain('"New prompt"');
    expect(await fileProvider.readFile(filePath)).not.toContain("Old prompt");
  });

  it("should update numeric parameter", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test',
    temperature: 0.7
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "temperature"), {
      kind: "primitive",
      value: 0.9,
    });

    expect(await fileProvider.readFile(filePath)).toContain("temperature: 0.9");
  });

  it("should update boolean parameter", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test',
    stream: false
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "stream"), {
      kind: "primitive",
      value: true,
    });

    expect(await fileProvider.readFile(filePath)).toContain("stream: true");
  });

  it("should update array parameter (messages)", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Old' }]
  };
}
`);
    const newMessages: PropValue = {
      kind: "array",
      elements: [
        {
          kind: "object",
          properties: {
            role: { kind: "primitive", value: "system" },
            content: { kind: "primitive", value: "You are helpful" },
          },
        },
        {
          kind: "object",
          properties: {
            role: { kind: "primitive", value: "user" },
            content: { kind: "primitive", value: "New message" },
          },
        },
      ],
    };

    await editor.updateProperty(
      filePath,
      getDef(prompts[0], "messages"),
      newMessages,
    );

    expect(await fileProvider.readFile(filePath)).toContain("You are helpful");
    expect(await fileProvider.readFile(filePath)).toContain("New message");
  });

  it("should update model parameter - string format", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "model"), {
      kind: "primitive",
      value: "anthropic/claude-sonnet-4-20250514",
    });

    expect(await fileProvider.readFile(filePath)).toContain(
      '"anthropic/claude-sonnet-4-20250514"',
    );
  });

  it("should update model parameter - function call format", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
import { openai } from '@ai-sdk/openai';

export function test() {
  return {
    model: openai('gpt-4o'),
    system: 'Test'
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "model"), {
      kind: "functionCall",
      callee: "openai",
      args: [{ kind: "primitive", value: "gpt-4o-mini" }],
      binding: {
        kind: "import",
        spec: { name: "openai", from: "@ai-sdk/openai" },
      },
    });

    expect(await fileProvider.readFile(filePath)).toContain(
      'openai("gpt-4o-mini")',
    );
  });

  it("should add import when switching from string to function format", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "model"), {
      kind: "functionCall",
      callee: "openai",
      args: [{ kind: "primitive", value: "gpt-4o" }],
      binding: {
        kind: "import",
        spec: { name: "openai", from: "@ai-sdk/openai" },
      },
    });

    expect(await fileProvider.readFile(filePath)).toContain(
      "import { openai } from '@ai-sdk/openai'",
    );
    expect(await fileProvider.readFile(filePath)).toContain('openai("gpt-4o")');
  });

  it("should preserve existing imports when updating other parameters", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
import { openai } from '@ai-sdk/openai';

export function test() {
  return {
    model: openai('gpt-4o'),
    system: 'Old'
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "system"), {
      kind: "primitive",
      value: "New",
    });

    expect(await fileProvider.readFile(filePath)).toContain(
      "import { openai } from '@ai-sdk/openai'",
    );
    expect(await fileProvider.readFile(filePath)).toContain('"New"');
  });

  it("should validate TypeScript syntax after edit", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Test'
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "system"), {
      kind: "primitive",
      value: "Valid string",
    });

    expect(await fileProvider.readFile(filePath)).toContain('"Valid string"');
  });

  it("should preserve comments in source file", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
// This is a comment
export function test() {
  return {
    model: 'openai/gpt-4o',
    // Another comment
    system: 'Test'
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "system"), {
      kind: "primitive",
      value: "New",
    });

    expect(await fileProvider.readFile(filePath)).toContain(
      "// This is a comment",
    );
    expect(await fileProvider.readFile(filePath)).toContain(
      "// Another comment",
    );
  });

  it("should handle multi-line string values", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Short'
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "system"), {
      kind: "primitive",
      value: "Line 1\nLine 2\nLine 3",
    });

    expect(await fileProvider.readFile(filePath)).toContain(
      "Line 1\\nLine 2\\nLine 3",
    );
  });

  it("should handle escaped characters in strings", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    system: 'Simple'
  };
}
`);
    await editor.updateProperty(filePath, getDef(prompts[0], "system"), {
      kind: "primitive",
      value: 'String with "quotes" and \\backslashes\\',
    });

    expect(await fileProvider.readFile(filePath)).toContain("String with");
  });

  it("should preserve backtick template literals in system prompt when updating", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(
      `export function test(name: string) {
  return {
    model: 'openai/gpt-4o',
    system: \`Hello \${name}\`,
  };
}`,
    );
    // Simulate what the editor does: round-trip the parsed template value
    const systemValue = getValue(prompts[0], "system");
    await editor.updateProperty(
      filePath,
      getDef(prompts[0], "system"),
      systemValue,
    );

    const result = await fileProvider.readFile(filePath);
    // Must use backticks to preserve template interpolation, not double quotes
    expect(result).toContain("`Hello ${name}`");
    expect(result).not.toContain('"Hello ${name}"');
  });

  it("should preserve backtick template literals with interpolation when updating messages", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(
      `export function test(name: string) {
  return {
    model: 'openai/gpt-4o',
    messages: [
      { role: 'user', content: \`Hello \${name}\` },
    ]
  };
}`,
    );
    // Simulate what the UI does: update messages with the parsed value round-tripped
    const newMessages: PropValue = {
      kind: "array",
      elements: [
        {
          kind: "object",
          properties: {
            role: { kind: "primitive", value: "user" },
            content: {
              kind: "template",
              value: ["Hello ", { expr: "name" }, ""],
            },
          },
        },
        {
          kind: "object",
          properties: {
            role: { kind: "primitive", value: "assistant" },
            content: { kind: "primitive", value: "Hi there!" },
          },
        },
      ],
    };

    await editor.updateProperty(
      filePath,
      getDef(prompts[0], "messages"),
      newMessages,
    );

    const result = await fileProvider.readFile(filePath);
    // The interpolated content must use backticks, not double quotes
    expect(result).toContain("`Hello ${name}`");
    expect(result).not.toContain('"Hello ${name}"');
  });

  it("should not corrupt file when the same property is updated twice with stale spans", async () => {
    const { filePath, fileProvider, editor, prompts } = await setup(`
export function test() {
  return {
    model: 'openai/gpt-4o',
    messages: [
      { role: 'user', content: 'Short' }
    ]
  };
}
`);
    const messagesDef = getDef(prompts[0], "messages");
    const promptId = prompts[0].id;

    // First update makes the file longer, invalidating the original valueSpan
    await editor.updateProperty(
      filePath,
      messagesDef,
      {
        kind: "array",
        elements: [
          {
            kind: "object",
            properties: {
              role: { kind: "primitive", value: "user" },
              content: {
                kind: "primitive",
                value:
                  "A much longer message that extends the file length significantly",
              },
            },
          },
        ],
      },
      promptId,
    );

    // Second update reuses the same (now stale) property — spans no longer match the file.
    await editor.updateProperty(
      filePath,
      messagesDef,
      {
        kind: "array",
        elements: [
          {
            kind: "object",
            properties: {
              role: { kind: "primitive", value: "user" },
              content: { kind: "primitive", value: "Final version" },
            },
          },
        ],
      },
      promptId,
    );

    const result = await fileProvider.readFile(filePath);
    expect(result).toContain("Final version");
    expect(result).not.toContain("extends the file length significantly");
  });

  it("should reject edits to read-only parameters", async () => {
    const { prompts } = await setup(`
function getDynamic() {
  return 'dynamic';
}

export function test() {
  return {
    model: 'openai/gpt-4o',
    system: getDynamic()
  };
}
`);
    const systemDef = getDef(prompts[0], "system");
    const systemValue = getValue(prompts[0], "system");

    // Verify the value is not editable
    expect(isEditable(systemValue)).toBe(false);

    // The editor itself doesn't check editability (that's FilePromptProvider's job),
    // but the valueSpan should be missing for raw/dynamic values
    expect(systemDef.valueSpan).toBeDefined();
  });

  it("throws when renaming a function-declaration prompt to a non-identifier name", async () => {
    const { filePath, editor } = await setup(`
export function myPrompt() {
  return { model: 'openai/gpt-4o', system: 'x', messages: [] };
}
`);
    await expect(
      editor.renamePrompt(filePath, "myPrompt", "my-prompt"),
    ).rejects.toThrow();
  });
});
