// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  activeCatalogIndex,
  defaultCall,
  findPreset,
  literalDefinition,
  setCallArgument,
  type ValueCatalog,
  type ValueFactory,
} from "ts-proppy";
import { describe, expect, it } from "vitest";
import { MemoryFileProvider } from "../../file-provider-memory.ts";
import { FilePromptProvider } from "../../prompt/file/file-prompt-provider.ts";
import type { NormalizedChatPrompt, PropValue } from "../../shared/types.ts";
import { VercelAISDK } from "./index.ts";
import { vercelModelDefinition } from "./model-definition.ts";

/** Every entry the hand-maintained `getModelCatalog()` offered. */
const FORMER_CATALOG = [
  ["OpenAI", "GPT-5.6 Sol", "openai", "gpt-5.6-sol"],
  ["OpenAI", "GPT-5.6 Terra", "openai", "gpt-5.6-terra"],
  ["OpenAI", "GPT-5.6 Luna", "openai", "gpt-5.6-luna"],
  ["OpenAI", "GPT-5.3 Codex", "openai", "gpt-5.3-codex"],
  ["OpenAI", "GPT-5.5 Pro", "openai", "gpt-5.5-pro"],
  ["OpenAI", "GPT-5.5", "openai", "gpt-5.5"],
  ["OpenAI", "GPT-5.4 Pro", "openai", "gpt-5.4-pro"],
  ["OpenAI", "GPT-5.4", "openai", "gpt-5.4"],
  ["OpenAI", "GPT-5.4 mini", "openai", "gpt-5.4-mini"],
  ["OpenAI", "GPT-5.4 nano", "openai", "gpt-5.4-nano"],
  ["Anthropic", "Claude Fable 5", "anthropic", "claude-fable-5"],
  ["Anthropic", "Claude Opus 5", "anthropic", "claude-opus-5"],
  ["Anthropic", "Claude Sonnet 5", "anthropic", "claude-sonnet-5"],
  ["Anthropic", "Claude Opus 4.8", "anthropic", "claude-opus-4-8"],
  ["Anthropic", "Claude Haiku 4.5", "anthropic", "claude-haiku-4-5"],
  ["Google", "Gemini 3.7 Flash", "google", "gemini-3.7-flash"],
  ["Google", "Gemini 3.6 Flash", "google", "gemini-3.6-flash"],
  ["Google", "Gemini 3.5 Flash", "google", "gemini-3.5-flash"],
  ["Google", "Gemini 3.5 Flash-Lite", "google", "gemini-3.5-flash-lite"],
  ["Google", "Gemini 3.1 Pro Preview", "google", "gemini-3.1-pro-preview"],
  ["Google", "Gemini 3.1 Flash-Lite", "google", "gemini-3.1-flash-lite"],
] as const;

const HELPER_CANDIDATE = {
  kind: "parameter",
  enclosingCall: {
    callee: "prompts",
    import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
  },
} as const;

const text = (value: string): PropValue => ({ kind: "primitive", value });
const call = (callee: string, id: string): PropValue => ({
  kind: "functionCall",
  callee,
  args: [text(id)],
});

function presets(catalog: ValueCatalog, group: string) {
  return catalog.groups.find(g => g.label === group)?.presets ?? [];
}

describe("vercelModelDefinition", () => {
  const def = vercelModelDefinition({});
  const [provider, gateway] = def.catalogs!;

  it("offers Provider and Gateway catalogs", () => {
    expect(provider.label).toBe("Provider");
    expect(gateway.label).toBe("Gateway");
  });

  it.each(
    FORMER_CATALOG,
  )("still offers %s's %s as a preset in both catalogs", (group, label, callee, modelId) => {
    const fn = presets(provider, group).find(p => p.label === label);
    expect(fn?.value).toMatchObject(call(callee, modelId));
    const str = presets(gateway, group).find(p => p.label === label);
    expect(str?.value).toEqual(text(`${callee}/${modelId}`));
  });

  it("binds provider calls through the helper's destructure first, then an import", () => {
    const group = provider.groups.find(g => g.label === "Anthropic")!;
    expect(group.factory?.binding).toEqual([
      HELPER_CANDIDATE,
      {
        kind: "import",
        spec: { name: "anthropic", from: "@ai-sdk/anthropic" },
      },
    ]);
    for (const preset of group.presets ?? []) {
      expect((preset.value as any).binding).toEqual(group.factory?.binding);
    }
  });

  it("offers a free-form gateway string", () => {
    expect(literalDefinition(gateway, def)?.type).toMatchObject({
      kind: "primitive",
    });
  });

  it("shows only the providers that were discovered, and only Providers keys", () => {
    const factory = (name: string, from: string): ValueFactory => ({
      def: {
        name,
        optional: false,
        type: { kind: "function", syntax: "", parameters: [] },
      },
      binding: { kind: "import", spec: { name, from } },
    });
    const discovered = vercelModelDefinition({
      providers: [
        factory("xai", "@ai-sdk/xai"),
        factory("anthropic", "@ai-sdk/anthropic"),
        factory("somethingElse", "@ai-sdk/anthropic"),
      ],
    });
    const groups = discovered.catalogs![0].groups.map(g => g.label);
    expect(groups).toEqual(["Anthropic", "xAI"]);
    // An installed provider with no curated models is still reachable.
    const xai = discovered.catalogs![0].groups[1];
    expect(xai.presets).toEqual([]);
    expect(xai.factory?.def.name).toBe("xai");
  });

  it("suggests every gateway model ID the installed SDK knows", () => {
    const withIds = vercelModelDefinition({
      model: {
        name: "model",
        optional: false,
        type: {
          kind: "union",
          syntax: "LanguageModel",
          types: [
            {
              kind: "constant",
              syntax: "'openai/gpt-5'",
              value: "openai/gpt-5",
            },
            { kind: "primitive", syntax: "string & {}", base: "string" },
            { kind: "opaque", syntax: "LanguageModelV3" },
          ],
        },
      },
    });
    const literal = literalDefinition(withIds.catalogs![1], withIds)!;
    expect(literal.type).toMatchObject({
      kind: "union",
      types: [{ value: "openai/gpt-5" }, { base: "string" }],
    });
  });
});

describe("model edits round-trip through the file", () => {
  const filePath = "/project/triage.prompt.ts";
  const source = `import { prompts } from '@evalution/vercel-ai-sdk';

export default prompts({ id: 'triage' }, ({ openai }) => ({
  triage: () => ({
    model: openai('gpt-4o'),
    system: 'Sort the ticket.',
  }),
}));
`;

  async function edit(model: PropValue) {
    const fileProvider = new MemoryFileProvider({ [filePath]: source });
    const provider = new FilePromptProvider({
      rootDir: "/project",
      fileProvider,
      sdk: new VercelAISDK(),
    });
    const updated = (await provider.updatePromptProperties(
      "triage.prompt.ts#triage",
      { style: "chat", model },
    )) as NormalizedChatPrompt;
    return { updated, text: await fileProvider.readFile(filePath) };
  }

  const def = vercelModelDefinition({});

  it("writes a provider preset and reads it back as the same preset", async () => {
    const preset = presets(def.catalogs![0], "Anthropic")[0];
    const { updated, text } = await edit(preset.value);
    expect(text).toContain(`anthropic("claude-fable-5")`);
    expect(text).toContain("({ openai, anthropic })");
    expect(findPreset(def.catalogs!, updated.model)?.preset).toBe(preset);
    expect(activeCatalogIndex(def.catalogs!, def, updated.model)).toBe(0);
  });

  it("writes a gateway preset and reads it back as the same preset", async () => {
    const preset = presets(def.catalogs![1], "OpenAI")[0];
    const { updated, text } = await edit(preset.value);
    expect(text).toContain(`model: "openai/gpt-5.6-sol"`);
    expect(findPreset(def.catalogs!, updated.model)?.preset).toBe(preset);
    expect(activeCatalogIndex(def.catalogs!, def, updated.model)).toBe(1);
  });

  it("writes a custom provider model built from the factory", async () => {
    const factory = def.catalogs![0].groups.find(g => g.label === "Google")!
      .factory!;
    const params =
      factory.def.type.kind === "function" ? factory.def.type.parameters : [];
    const custom = setCallArgument(
      defaultCall(factory),
      params,
      0,
      text("my-tuned-gemini"),
    );
    const { updated, text: written } = await edit(custom);
    expect(written).toContain(`google("my-tuned-gemini")`);
    expect(findPreset(def.catalogs!, updated.model)).toBeUndefined();
    expect(updated.model).toMatchObject(call("google", "my-tuned-gemini"));
  });

  it("writes a custom gateway string", async () => {
    const { updated, text: written } = await edit(text("xai/grok-4.3"));
    expect(written).toContain(`model: "xai/grok-4.3"`);
    expect(activeCatalogIndex(def.catalogs!, def, updated.model)).toBe(1);
  });
});
