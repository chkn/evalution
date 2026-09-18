// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs";
import type {
  PropDefinition,
  PropType,
  PropValue,
  ValueCatalog,
} from "ts-proppy";
import {
  extractPropertiesFromDeclaration,
  findTypeDeclaration,
  valueToSourceText,
} from "ts-proppy";
import ts from "typescript";
import type {
  ProbeResults,
  TypeProbe,
} from "../prompt/file/prompt-file-type.ts";
import type {
  NormalizedChatPrompt,
  NormalizedMessage,
  NormalizedParameter,
  NormalizedPromptUpdates,
  ParsedPrompt,
} from "../shared/types.ts";
import {
  assertUpdateStyle,
  findPackageDts,
  isMissingPackage,
  missingPackageMessage,
  type SDKAdapter,
} from "./sdk-adapter.ts";

// Use an `import(...)` type query so the type is derived from `@google/genai`
// without emitting a runtime import — the package is an optional peer
// dependency, imported lazily in `executeConfig`.
type BaseCreateInteractionParams = Parameters<
  typeof import("@google/genai").GoogleGenAI.prototype.interactions.create
>[0];

const MODEL_KEY = "model";
const AGENT_KEY = "agent";
const SYSTEM_KEY = "system_instruction";
const INPUT_KEY = "input";
const GENERATION_CONFIG_KEY = "generation_config";
const AGENT_CONFIG_KEY = "agent_config";

// Fallback parameter definitions for GenerationConfig from @google/genai@1.50.0
// (GenerationConfig_2 in dist/genai.d.ts — the Interactions-API variant).
// Used when the package's .d.ts cannot be found or parsed at runtime.
const FALLBACK_GENERATION_CONFIG_PARAMS: PropDefinition[] = [
  {
    name: "temperature",
    description: "Controls the randomness of the output.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "top_p",
    description:
      "The maximum cumulative probability of tokens to consider when sampling.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "max_output_tokens",
    description: "The maximum number of tokens to include in the response.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "seed",
    description: "Seed used in decoding for reproducibility.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "stop_sequences",
    description:
      "A list of character sequences that will stop output interaction.",
    type: {
      kind: "array",
      syntax: "string[]",
      element: {
        name: "",
        type: { kind: "primitive", syntax: "string" },
        optional: false,
      },
    },
    optional: true,
  },
  {
    name: "thinking_level",
    description: "The level of thought tokens that the model should generate.",
    type: {
      kind: "union",
      syntax: "'minimal' | 'low' | 'medium' | 'high'",
      types: [
        { kind: "constant", syntax: "'minimal'", value: "minimal" },
        { kind: "constant", syntax: "'low'", value: "low" },
        { kind: "constant", syntax: "'medium'", value: "medium" },
        { kind: "constant", syntax: "'high'", value: "high" },
      ],
    },
    optional: true,
  },
  {
    name: "thinking_summaries",
    description: "Whether to include thought summaries in the response.",
    type: {
      kind: "union",
      syntax: "'auto' | 'none'",
      types: [
        { kind: "constant", syntax: "'auto'", value: "auto" },
        { kind: "constant", syntax: "'none'", value: "none" },
      ],
    },
    optional: true,
  },
];

/** A model or agent ID with its display name. */
interface CuratedID {
  label: string;
  id: string;
}

/**
 * The models `interactions.create` accepts — a subset of the full Gemini
 * lineup. See https://ai.google.dev/gemini-api/docs/interactions
 */
const CURATED_MODELS: readonly CuratedID[] = [
  { label: "Gemini 3.7 Flash", id: "gemini-3.7-flash" },
  { label: "Gemini 3.6 Flash", id: "gemini-3.6-flash" },
  { label: "Gemini 3.5 Flash", id: "gemini-3.5-flash" },
  { label: "Gemini 3.5 Flash-Lite", id: "gemini-3.5-flash-lite" },
  { label: "Gemini 3.1 Pro Preview", id: "gemini-3.1-pro-preview" },
  { label: "Gemini 3.1 Flash-Lite", id: "gemini-3.1-flash-lite" },
  { label: "Gemini 3 Flash Preview", id: "gemini-3-flash-preview" },
  { label: "Gemini 2.5 Pro", id: "gemini-2.5-pro" },
  { label: "Gemini 2.5 Flash", id: "gemini-2.5-flash" },
  { label: "Gemini 2.5 Flash-Lite", id: "gemini-2.5-flash-lite" },
];

/** The agents `interactions.create` accepts. */
const CURATED_AGENTS: readonly CuratedID[] = [
  { label: "Deep Research Preview", id: "deep-research-preview-04-2026" },
  {
    label: "Deep Research Max Preview",
    id: "deep-research-max-preview-04-2026",
  },
];

/** Which of the two request shapes a config is. */
type Variant = typeof MODEL_KEY | typeof AGENT_KEY;

/** Each variant's own settings, which are invalid under the other. */
const VARIANT_CONFIG_KEY: Record<Variant, string> = {
  model: GENERATION_CONFIG_KEY,
  agent: AGENT_CONFIG_KEY,
};

const STRING: PropType = {
  kind: "primitive",
  syntax: "string",
  base: "string",
};

/** One variant's fragment of the config, `{ model: … }` or `{ agent: … }`. */
function variantType(key: Variant, idType: PropType = STRING): PropType {
  return {
    kind: "object",
    syntax: `{ ${key}: ${key === MODEL_KEY ? "Model" : "AgentOption"} }`,
    properties: [{ name: key, type: idType, optional: false }],
  };
}

/** The model slot's type when it couldn't be resolved. */
const FALLBACK_MODEL_TYPE: PropType = {
  kind: "union",
  syntax: "{ model: Model } | { agent: AgentOption }",
  types: [variantType(MODEL_KEY), variantType(AGENT_KEY)],
};

/** Probe name for the model slot's type, as reported in project results. */
const MODEL_PROBE = "model";

/**
 * The model slot as a union of two config fragments: each variant's own ID
 * key, read off the SDK's own request types.
 */
const MODEL_PROJECT_PROBES: TypeProbe[] = [
  {
    kind: "type",
    name: MODEL_PROBE,
    expression:
      'Pick<import("@google/genai").Interactions.CreateModelInteraction, "model"> | ' +
      'Pick<import("@google/genai").Interactions.CreateAgentInteraction, "agent">',
    syntax: "{ model: Model } | { agent: AgentOption }",
  },
];

/** The variant member of a resolved model type, by the key it carries. */
function memberFor(type: PropType, key: Variant): PropType {
  const members = type.kind === "union" ? type.types : [type];
  return (
    members.find(
      m => m.kind === "object" && m.properties.some(p => p.name === key),
    ) ?? variantType(key)
  );
}

function fragment(key: Variant, id: string): PropValue {
  return {
    kind: "object",
    properties: { [key]: { kind: "primitive", value: id } },
    displayValue: id,
  };
}

/** Which variant a model fragment is, if it is one. */
function variantOf(value: PropValue | null | undefined): Variant | undefined {
  if (value?.kind !== "object") return undefined;
  if (MODEL_KEY in value.properties) return MODEL_KEY;
  if (AGENT_KEY in value.properties) return AGENT_KEY;
  return undefined;
}

/**
 * {@link SDKAdapter} implementation for the Google GenAI
 * [Interactions API](https://ai.google.dev/gemini-api/docs/interactions)
 * (`@google/genai` package). Currently experimental and untested.
 */
export class GeminiInteractionsSDK implements SDKAdapter {
  readonly promptsHelperImport = "FIXME";

  getProjectProbes(language: string): TypeProbe[] {
    return language === "typescript" ? MODEL_PROJECT_PROBES : [];
  }

  /**
   * One model row whose value is an honest config fragment —
   * `{ model: "gemini-3.5-flash" }` or `{ agent: "deep-research-…" }` —
   * because `interactions.create` takes one or the other, never both. The
   * **Models** and **Agents** catalogs each narrow their free-form entry to
   * their own variant.
   */
  async getModelDefinition(project: ProbeResults): Promise<PropDefinition> {
    const resolved = project[MODEL_PROBE];
    const type =
      resolved && !Array.isArray(resolved)
        ? resolved.type
        : FALLBACK_MODEL_TYPE;
    const catalog = (
      key: Variant,
      label: string,
      ids: readonly CuratedID[],
    ): ValueCatalog => ({
      label,
      groups: [
        {
          label: "Google",
          icon: "Google",
          presets: ids.map(({ label, id }) => ({
            label,
            value: fragment(key, id),
          })),
        },
      ],
      literal: { name: "model", type: memberFor(type, key), optional: false },
    });
    return {
      name: "model",
      type,
      optional: false,
      catalogs: [
        catalog(MODEL_KEY, "Models", CURATED_MODELS),
        catalog(AGENT_KEY, "Agents", CURATED_AGENTS),
      ],
    };
  }

  // FIXME: These are always `GenerationConfig_2`'s fields, which only apply to
  // the model variant. For an agent, `normalizePrompt` reads settings from the
  // prompt's own `agent_config` and `denormalizeUpdates` writes them there, but
  // "Add setting" still offers generation config fields. This API has no way
  // to know the variant; it would need the prompt (or both variants' fields).
  getModelParameters(rootDir: string): PropDefinition[] {
    try {
      const dtsPath = findPackageDts(
        "@google/genai",
        "dist/genai.d.ts",
        rootDir,
      );
      if (dtsPath) {
        const sourceText = fs.readFileSync(dtsPath, "utf-8");
        const sourceFile = ts.createSourceFile(
          dtsPath,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
        );
        const decl = findTypeDeclaration(sourceFile, "GenerationConfig_2");
        if (decl)
          return extractPropertiesFromDeclaration(decl, sourceFile).definitions;
      }
    } catch {
      // fall through to hardcoded defaults
    }
    return FALLBACK_GENERATION_CONFIG_PARAMS;
  }

  async executeConfig(config: BaseCreateInteractionParams): Promise<undefined> {
    // Import `@google/genai` lazily so it stays an optional peer dependency:
    // only users who execute a Gemini Interactions prompt need it installed.
    // This adapter has no tracing support, so it ignores the route's `traceId`
    // and produces no spans.
    let GoogleGenAI: typeof import("@google/genai").GoogleGenAI;
    try {
      ({ GoogleGenAI } = await import("@google/genai"));
    } catch (err) {
      if (!isMissingPackage(err, "@google/genai")) throw err;
      throw new Error(missingPackageMessage("@google/genai"), { cause: err });
    }
    const client = new GoogleGenAI({});
    await client.interactions.create({ ...config, store: false });
    // No completion handle: this call is awaited to completion here, so there
    // is nothing left for a caller to wait on.
    return undefined;
  }

  normalizePrompt(prompt: ParsedPrompt): NormalizedChatPrompt {
    const { definitions, values } = prompt.extractedProps;
    const systemValue = values?.[SYSTEM_KEY];
    const inputValue = values?.[INPUT_KEY];
    const modelValue = values?.[MODEL_KEY];
    const agentValue = values?.[AGENT_KEY];

    // The model row is the fragment of the config that picks the variant.
    const variant: Variant = !modelValue && agentValue ? AGENT_KEY : MODEL_KEY;
    const idValue = variant === MODEL_KEY ? modelValue : agentValue;
    const model: PropValue | undefined = idValue && {
      kind: "object",
      properties: { [variant]: idValue },
      displayValue:
        idValue.kind === "primitive"
          ? String(idValue.value)
          : valueToSourceText(idValue),
    };

    // Settings come from the variant in effect: `generation_config` for a
    // model, `agent_config` for an agent.
    const configKey = VARIANT_CONFIG_KEY[variant];
    const configDef = definitions.find(d => d.name === configKey);
    const configValue = values?.[configKey];
    const configProps =
      configValue?.kind === "object" ? configValue.properties : {};
    const configSubDefs: PropDefinition[] =
      configDef?.type.kind === "object" ? configDef.type.properties : [];

    const modelParameters: NormalizedParameter[] = configSubDefs.map(def => ({
      def,
      value: configProps[def.name],
    }));

    return {
      style: "chat",
      id: prompt.id,
      providerId: prompt.providerId,
      name: prompt.name,
      functionParameters: prompt.functionParameters,
      metadata: prompt.metadata,
      treePath: prompt.treePath,
      model,
      // Capabilities of `interactions.create`, not verdicts on these values.
      modelEditable: true,
      system: systemValue,
      systemEditable: true,
      messages: extractMessages(inputValue),
      messagesEditable: true,
      modelParameters,
    };
  }

  denormalizeUpdates(
    updates: NormalizedPromptUpdates,
    currentValues?: Record<string, PropValue>,
  ): Record<string, PropValue | null> {
    assertUpdateStyle(updates, "chat");
    const out: Record<string, PropValue | null> = {};
    // Only null-out keys that actually exist in the file, to avoid "Property
    // not found" errors from updatePromptProperties.
    const remove = (key: string) => {
      if (currentValues && key in currentValues) out[key] = null;
    };
    const currentVariant: Variant | undefined =
      currentValues && MODEL_KEY in currentValues
        ? MODEL_KEY
        : currentValues && AGENT_KEY in currentValues
          ? AGENT_KEY
          : undefined;
    let variant = currentVariant ?? MODEL_KEY;

    if ("model" in updates) {
      const next = variantOf(updates.model);
      if (!next) {
        remove(MODEL_KEY);
        remove(AGENT_KEY);
      } else if (updates.model?.kind === "object") {
        const other: Variant = next === MODEL_KEY ? AGENT_KEY : MODEL_KEY;
        out[next] = updates.model.properties[next];
        remove(other);
        // The other variant's settings are invalid under this one.
        if (currentVariant && currentVariant !== next) {
          remove(VARIANT_CONFIG_KEY[other]);
        }
        variant = next;
      }
    }
    if ("system" in updates) out[SYSTEM_KEY] = updates.system ?? null;
    if ("messages" in updates) {
      out[INPUT_KEY] =
        updates.messages == null ? null : messagesToValue(updates.messages);
    }
    if (updates.modelParameters) {
      const configKey = VARIANT_CONFIG_KEY[variant];
      const current =
        variant === currentVariant ? currentValues?.[configKey] : undefined;
      const merged: Record<string, PropValue> =
        current?.kind === "object" ? { ...current.properties } : {};
      for (const [name, value] of Object.entries(updates.modelParameters)) {
        if (value === null) delete merged[name];
        else merged[name] = value;
      }
      if (Object.keys(merged).length > 0) {
        out[configKey] = { kind: "object", properties: merged };
      } else {
        remove(configKey);
      }
    }
    return out;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a {@link NormalizedMessage} array into a PropValue representing the
 * `input` property: an array of [Step](https://ai.google.dev/api/interactions-api#Resource:Step)
 * objects (`{type: 'user_input' | 'model_output', content: [...]}`), each
 * carrying a single text [Content](https://ai.google.dev/api/interactions-api#schema-example-Content-text).
 */
function messagesToValue(msgs: NormalizedMessage[]): PropValue {
  return {
    kind: "array",
    elements: msgs.map(msg => ({
      kind: "object",
      properties: {
        type: {
          kind: "primitive",
          value: msg.role === "assistant" ? "model_output" : "user_input",
        },
        content: {
          kind: "array",
          elements: [
            {
              kind: "object",
              properties: {
                type: { kind: "primitive", value: "text" },
                text: msg.content,
              },
            },
          ],
        },
      },
    })),
  };
}

const EMPTY_CONTENT: PropValue = { kind: "primitive", value: "" };

// Handles a single content object (e.g. {type: 'text', text: '...'})
function extractContent(
  el: PropValue | undefined,
): NormalizedMessage | undefined {
  if (el?.kind !== "object" || el.properties.type?.kind !== "primitive") return;
  switch (el.properties.type.value) {
    case "text":
      // Content carries no role; default to 'user'. The `model_output` step
      // handler in extractMessages overwrites this to 'assistant' as needed.
      return { role: "user", content: el.properties.text ?? EMPTY_CONTENT };
    // FIXME: Handle other content types
  }
}

/**
 * Extract a {@link NormalizedMessage} array from the `input` PropValue.
 *
 * The `input` field can be:
 * - A primitive string (single user message)
 * - A single content object (e.g. `{type: 'text', text: '...'}`)
 * - An array of Step objects (https://ai.google.dev/api/interactions-api#Resource:Step)
 * - An array of Content objects (https://ai.google.dev/api/interactions-api#schema-example-Content-text)
 *
 * The Interactions API uses `"model"` for assistant messages; we translate
 * `"model"` → `"assistant"` on the way in.
 */
function extractMessages(value: PropValue | undefined): NormalizedMessage[] {
  if (!value) return [];

  // Single content object case: {type: 'text', text: '...'}
  const content = extractContent(value);
  if (content) return [content];

  // Otherwise, if it's not an array, treat as a single user message
  if (value.kind !== "array") return [{ role: "user", content: value }];

  const results: NormalizedMessage[] = [];
  for (const el of value.elements) {
    const content = extractContent(el);
    if (content) {
      results.push(content);
      continue;
    }

    if (el.kind !== "object" || el.properties.type?.kind !== "primitive") {
      continue;
    }

    // Step object case: {type: 'user_input' | 'model_output', content: [...]}
    switch (el.properties.type.value) {
      case "user_input":
        results.push(...extractMessages(el.properties.content));
        break;
      case "model_output":
        for (const msg of extractMessages(el.properties.content)) {
          results.push({ ...msg, role: "assistant" });
        }
        break;
      // FIXME: Handle other types of steps?
    }
  }
  return results;
}
