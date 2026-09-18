// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  CalleeBinding,
  PropDefinition,
  PropType,
  PropValue,
  ValueCatalog,
  ValueCatalogGroup,
  ValueFactory,
} from "ts-proppy";
import type {
  ProbeResults,
  TypeProbe,
} from "../../prompt/file/prompt-file-type.ts";

/** The `prompts()` factory from `@evalution/vercel-ai-sdk`. */
export const PROMPTS_HELPER_CALL = {
  callee: "prompts",
  import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
} as const;

/**
 * Every provider the `@evalution/vercel-ai-sdk` helper's `Providers` interface
 * covers, by factory name, with its package and display label. Discovery is
 * limited to these: they are the names a `prompts(({ … }) => …)` factory can
 * destructure.
 */
const PROVIDERS: Record<string, { module: string; label: string }> = {
  openai: { module: "@ai-sdk/openai", label: "OpenAI" },
  anthropic: { module: "@ai-sdk/anthropic", label: "Anthropic" },
  google: { module: "@ai-sdk/google", label: "Google" },
  vertex: { module: "@ai-sdk/google-vertex", label: "Google Vertex AI" },
  azure: { module: "@ai-sdk/azure", label: "Azure OpenAI" },
  bedrock: { module: "@ai-sdk/amazon-bedrock", label: "Amazon Bedrock" },
  cohere: { module: "@ai-sdk/cohere", label: "Cohere" },
  mistral: { module: "@ai-sdk/mistral", label: "Mistral" },
  groq: { module: "@ai-sdk/groq", label: "Groq" },
  cerebras: { module: "@ai-sdk/cerebras", label: "Cerebras" },
  deepinfra: { module: "@ai-sdk/deepinfra", label: "DeepInfra" },
  deepseek: { module: "@ai-sdk/deepseek", label: "DeepSeek" },
  fireworks: { module: "@ai-sdk/fireworks", label: "Fireworks" },
  perplexity: { module: "@ai-sdk/perplexity", label: "Perplexity" },
  replicate: { module: "@ai-sdk/replicate", label: "Replicate" },
  togetherai: { module: "@ai-sdk/togetherai", label: "Together AI" },
  xai: { module: "@ai-sdk/xai", label: "xAI" },
  vercel: { module: "@ai-sdk/vercel", label: "Vercel" },
  gateway: { module: "@ai-sdk/gateway", label: "AI Gateway" },
  elevenlabs: { module: "@ai-sdk/elevenlabs", label: "ElevenLabs" },
  assemblyai: { module: "@ai-sdk/assemblyai", label: "AssemblyAI" },
  deepgram: { module: "@ai-sdk/deepgram", label: "Deepgram" },
  gladia: { module: "@ai-sdk/gladia", label: "Gladia" },
  revai: { module: "@ai-sdk/revai", label: "Rev.ai" },
  luma: { module: "@ai-sdk/luma", label: "Luma" },
  fal: { module: "@ai-sdk/fal", label: "fal" },
  hume: { module: "@ai-sdk/hume", label: "Hume" },
  lmnt: { module: "@ai-sdk/lmnt", label: "LMNT" },
};

/** What a language model is, as `generateText`'s `model` accepts it. */
const LANGUAGE_MODEL = 'import("ai").LanguageModel';

/** Probe names, as reported in {@link ProbeResults}. */
export const MODEL_PROBE = "model";
export const PROVIDERS_PROBE = "providers";

/** The project probes behind {@link vercelModelDefinition}. */
export const MODEL_PROJECT_PROBES: TypeProbe[] = [
  {
    kind: "type",
    name: MODEL_PROBE,
    expression: LANGUAGE_MODEL,
    syntax: "LanguageModel",
  },
  {
    kind: "factories",
    name: PROVIDERS_PROBE,
    modules: [...new Set(Object.values(PROVIDERS).map(p => p.module))],
    produces: LANGUAGE_MODEL,
  },
];

/** A curated model, offered as a preset under both catalogs. */
interface CuratedModel {
  provider: string;
  label: string;
  modelId: string;
}

function model(provider: string, label: string, modelId: string): CuratedModel {
  return { provider, label, modelId };
}

/**
 * Popular models with friendly names. Polish rather than the only way to reach
 * a model: every ID the installed provider package knows is also a suggestion
 * when typing a custom one. Newest first within a provider.
 */
export const CURATED_MODELS: readonly CuratedModel[] = [
  model("openai", "GPT-5.6 Sol", "gpt-5.6-sol"),
  model("openai", "GPT-5.6 Terra", "gpt-5.6-terra"),
  model("openai", "GPT-5.6 Luna", "gpt-5.6-luna"),
  model("openai", "GPT-5.3 Codex", "gpt-5.3-codex"),
  model("openai", "GPT-5.5 Pro", "gpt-5.5-pro"),
  model("openai", "GPT-5.5", "gpt-5.5"),
  model("openai", "GPT-5.4 Pro", "gpt-5.4-pro"),
  model("openai", "GPT-5.4", "gpt-5.4"),
  model("openai", "GPT-5.4 mini", "gpt-5.4-mini"),
  model("openai", "GPT-5.4 nano", "gpt-5.4-nano"),

  model("anthropic", "Claude Fable 5", "claude-fable-5"),
  model("anthropic", "Claude Opus 5", "claude-opus-5"),
  model("anthropic", "Claude Sonnet 5", "claude-sonnet-5"),
  model("anthropic", "Claude Opus 4.8", "claude-opus-4-8"),
  model("anthropic", "Claude Haiku 4.5", "claude-haiku-4-5"),

  model("google", "Gemini 3.7 Flash", "gemini-3.7-flash"),
  model("google", "Gemini 3.6 Flash", "gemini-3.6-flash"),
  model("google", "Gemini 3.5 Flash", "gemini-3.5-flash"),
  model("google", "Gemini 3.5 Flash-Lite", "gemini-3.5-flash-lite"),
  model("google", "Gemini 3.1 Pro Preview", "gemini-3.1-pro-preview"),
  model("google", "Gemini 3.1 Flash-Lite", "gemini-3.1-flash-lite"),
];

const STRING: PropType = {
  kind: "primitive",
  syntax: "string",
  base: "string",
};

/** A provider factory as the checker would describe it, for when it can't. */
function fallbackFactory(name: string): ValueFactory {
  return {
    def: {
      name,
      type: {
        kind: "function",
        syntax: "(modelId: string) => LanguageModel",
        parameters: [{ name: "modelId", type: STRING, optional: false }],
      },
      optional: false,
    },
    binding: {
      kind: "import",
      spec: { name, from: PROVIDERS[name].module },
    },
  };
}

/** The providers offered when no checker could discover the installed ones. */
const FALLBACK_FACTORIES: ValueFactory[] = [
  fallbackFactory("openai"),
  fallbackFactory("anthropic"),
  fallbackFactory("google"),
];

/** The model slot's type when it couldn't be resolved: a gateway string or a model object. */
const FALLBACK_MODEL_TYPE: PropType = {
  kind: "union",
  syntax: "LanguageModel",
  types: [STRING, { kind: "opaque", syntax: "LanguageModelV3" }],
};

/** Binding candidates for a provider call: the helper's destructure, then the import. */
function providerBinding(factory: ValueFactory): CalleeBinding[] {
  const imports = Array.isArray(factory.binding)
    ? factory.binding
    : [factory.binding];
  return [
    { kind: "parameter", enclosingCall: PROMPTS_HELPER_CALL },
    ...imports,
  ];
}

function providerCall(
  provider: string,
  modelId: string,
  binding?: CalleeBinding[],
): PropValue {
  return {
    kind: "functionCall",
    callee: provider,
    args: [{ kind: "primitive", value: modelId }],
    ...(binding && { binding }),
  };
}

/**
 * The string members of the model type — the IDs `generateText` accepts as a
 * gateway model string, suggestions included — as the Gateway catalog's
 * free-form entry.
 */
function gatewayLiteral(type: PropType): PropDefinition {
  const members = type.kind === "union" ? type.types : [type];
  const strings = members.filter(
    t =>
      (t.kind === "constant" && typeof t.value === "string") ||
      (t.kind === "primitive" && (t.base ?? t.syntax) === "string"),
  );
  return {
    name: "model",
    type:
      strings.length === 0
        ? STRING
        : strings.length === 1
          ? strings[0]
          : { kind: "union", syntax: "GatewayModelId", types: strings },
    optional: false,
  };
}

/**
 * The Vercel AI SDK's model slot: its type, a **Provider** catalog with a group
 * per installed provider package (its factory, and any curated presets for it)
 * and a **Gateway** catalog of model strings.
 */
export function vercelModelDefinition(project: ProbeResults): PropDefinition {
  const resolvedModel = project[MODEL_PROBE];
  const modelType =
    resolvedModel && !Array.isArray(resolvedModel)
      ? resolvedModel.type
      : FALLBACK_MODEL_TYPE;

  const discovered = project[PROVIDERS_PROBE];
  const factories = (
    Array.isArray(discovered) ? discovered : FALLBACK_FACTORIES
  ).filter(f => f.def.name in PROVIDERS);

  // Providers with presets first, in curated order; the rest alphabetically.
  const curatedOrder = [...new Set(CURATED_MODELS.map(m => m.provider))];
  const rank = (name: string) => {
    const i = curatedOrder.indexOf(name);
    return i < 0 ? curatedOrder.length : i;
  };
  const sorted = [...factories].sort(
    (a, b) =>
      rank(a.def.name) - rank(b.def.name) ||
      a.def.name.localeCompare(b.def.name),
  );

  const providerGroups: ValueCatalogGroup[] = sorted.map(factory => {
    const name = factory.def.name;
    const binding = providerBinding(factory);
    const { label } = PROVIDERS[name];
    return {
      label,
      icon: label,
      presets: CURATED_MODELS.filter(m => m.provider === name).map(m => ({
        label: m.label,
        value: providerCall(name, m.modelId, binding),
      })),
      factory: { def: factory.def, binding },
    };
  });

  const gatewayGroups: ValueCatalogGroup[] = curatedOrder.map(provider => ({
    label: PROVIDERS[provider].label,
    icon: PROVIDERS[provider].label,
    presets: CURATED_MODELS.filter(m => m.provider === provider).map(m => ({
      label: m.label,
      value: { kind: "primitive", value: `${provider}/${m.modelId}` },
    })),
  }));

  const catalogs: ValueCatalog[] = [
    {
      label: "Provider",
      description: 'Call a provider function (e.g. openai("gpt-5.5"))',
      groups: providerGroups,
    },
    {
      label: "Gateway",
      description: 'Use a gateway model string (e.g. "openai/gpt-5.5")',
      groups: gatewayGroups,
      literal: gatewayLiteral(modelType),
    },
  ];

  return { name: "model", type: modelType, optional: false, catalogs };
}
