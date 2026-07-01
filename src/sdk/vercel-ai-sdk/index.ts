// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs";
import type { PropDefinition, PropValue } from "ts-proppy";
import {
  extractPropertiesFromDeclaration,
  findTypeDeclaration,
} from "ts-proppy";
import ts from "typescript";
import { isEditable } from "../../shared/helpers.ts";
import {
  CONFIG_FILE_RELATIVE_PATH,
  type SetupTask,
} from "../../shared/setup-task.ts";
import type {
  CalleeBinding,
  ModelInfo,
  ModelPropValue,
  NormalizedMessage,
  NormalizedParameter,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  NormalizedToolCall,
  ParsedPrompt,
} from "../../shared/types.ts";
import { setupGlobalOTelPipeline } from "../../trace/otel-global-pipeline.ts";
import type { TraceIngestor } from "../../trace/trace-ingestor.ts";
import {
  type ExecuteConfigOptions,
  findPackageDts,
  type SDKAdapter,
} from "../sdk-adapter.ts";
import {
  isPerPromptTelemetry,
  isVercelAISDKTelemetry,
  type PerPromptTelemetry,
  type PerTraceTelemetry,
  toArray,
  VercelAISDKTelemetry,
} from "./telemetry.ts";

const MODEL_KEY = "model";
const SYSTEM_KEY = "system";
const MESSAGES_KEY = "messages";
const RESERVED_KEYS = new Set([MODEL_KEY, SYSTEM_KEY, MESSAGES_KEY]);

// Fallback parameter definitions for the Vercel AI SDK's `CallSettings` (from
// the `ai` package's dist/index.d.ts). Used when the package's .d.ts cannot be
// found or read at runtime — e.g. in environments without filesystem access
// such as a browser/service-worker bundle.
const FALLBACK_CALL_SETTINGS_PARAMS: PropDefinition[] = [
  {
    name: "maxOutputTokens",
    description: "Maximum number of tokens to generate.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "temperature",
    description:
      "Temperature setting. The value is passed through to the provider. " +
      "The range depends on the provider and model.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "topP",
    description:
      "Nucleus sampling. The value is passed through to the provider. " +
      "The range depends on the provider and model.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "topK",
    description:
      "Only sample from the top K options for each subsequent token.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "presencePenalty",
    description:
      "Presence penalty setting. It affects the likelihood of the model to " +
      "repeat information that is already in the prompt.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "frequencyPenalty",
    description:
      "Frequency penalty setting. It affects the likelihood of the model to " +
      "repeatedly use the same words or phrases.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "stopSequences",
    description: "Stop sequences. If set, the model will stop generating text.",
    type: {
      kind: "array",
      syntax: "string[]",
      elementType: { kind: "primitive", syntax: "string" },
    },
    optional: true,
  },
  {
    name: "seed",
    description: "The seed (integer) to use for random sampling.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
  {
    name: "maxRetries",
    description: "Maximum number of retries. Set to 0 to disable retries.",
    type: { kind: "primitive", syntax: "number" },
    optional: true,
  },
];

/** The `prompts()` factory from `@evalution/vercel-ai-sdk`. */
const PROMPTS_HELPER_CALL = {
  callee: "prompts",
  import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
} as const;

/** Build the binding-candidate array for a provider function call. */
function providerBinding(provider: string): CalleeBinding[] {
  return [
    { kind: "parameter", enclosingCall: PROMPTS_HELPER_CALL },
    { kind: "import", spec: { name: provider, from: `@ai-sdk/${provider}` } },
  ];
}

/** Build a {@link ModelInfo} entry from group, label, provider, and model ID. */
function model(
  group: string,
  label: string,
  provider: string,
  modelId: string,
): ModelInfo {
  const id = `${provider}/${modelId}`;
  return {
    id,
    label,
    group,
    values: {
      function: {
        kind: "functionCall",
        callee: provider,
        args: [{ kind: "primitive", value: modelId }],
        binding: providerBinding(provider),
      },
      string: { kind: "primitive", value: id },
    },
  };
}

/** Build a custom-value template entry for a provider (used in `groups.{provider}.customValueTemplates.function`). */
function customValueTemplate(provider: string): ModelPropValue {
  return {
    kind: "functionCall",
    callee: provider,
    args: [{ kind: "primitive", value: "$input" }],
    binding: providerBinding(provider),
  };
}

/** Starter contents of `.evalution/config.ts` for the Vercel AI SDK. */
const CONFIG_FILE_CONTENTS = `import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider, VercelAISDK } from 'evalution';

export default {
  promptProviders: [
    new FilePromptProvider({
      sdk: new VercelAISDK(),
    }),
  ],
} satisfies EvalutionConfig;
`;

// Module-level (not instance-level) cache: the v7 native `registerTelemetry`
// call is process-global state, so it must happen at most once even if
// multiple `VercelAISDK` adapters are configured. (The v6 OTel path is
// further deduplicated across *other* SDKs too — see
// `setupGlobalOTelPipeline`.)
let globalIngestionSetup: Promise<TraceIngestor | undefined> | undefined;

/**
 * {@link SDKAdapter} implementation for the
 * [Vercel AI SDK](https://sdk.vercel.ai/).
 *
 * - `getModelParameters` reads `CallSettings` from the SDK's `.d.ts` bundle
 *   and surfaces parameters with simple types that can be edited in the UI.
 * - `executeConfig` delegates to `generateText`.
 */
export class VercelAISDK implements SDKAdapter {
  readonly promptsHelperImport = PROMPTS_HELPER_CALL.import.from;

  /**
   * Onboarding task: install the SDK package, then drop a starter config.
   * @internal
   */
  static readonly setupTask: SetupTask = {
    id: "vercel-ai-sdk",
    label: "AI SDK",
    icon: "vercel",
    steps: [
      {
        kind: "install_package",
        id: "install-ai",
        package: "ai",
      },
      {
        kind: "install_package",
        id: "install-evalution-vercel-ai-sdk",
        package: "@evalution/vercel-ai-sdk",
      },
      {
        kind: "create_config",
        id: "create-config",
        path: CONFIG_FILE_RELATIVE_PATH,
        contents: CONFIG_FILE_CONTENTS,
      },
    ],
  };

  getModelCatalog() {
    // FIXME: Can we read this from the SDK instead of hardcoding it?
    return Promise.resolve({
      modelValueTypes: {
        function: {
          label: "Provider",
          description: 'Call provider function (e.g. openai("gpt-4o"))',
        },
        string: {
          label: "Gateway",
          description: 'Use a gateway model string (e.g. "openai/gpt-4o")',
        },
      },
      groups: {
        OpenAI: {
          customValueTemplates: { function: customValueTemplate("openai") },
        },
        Anthropic: {
          customValueTemplates: { function: customValueTemplate("anthropic") },
        },
        Google: {
          customValueTemplates: { function: customValueTemplate("google") },
        },
      },
      models: [
        model("OpenAI", "GPT-5.5 Pro", "openai", "gpt-5.5-pro"),
        model("OpenAI", "GPT-5.5", "openai", "gpt-5.5"),
        model("OpenAI", "GPT-5.4 Pro", "openai", "gpt-5.4-pro"),
        model("OpenAI", "GPT-5.4", "openai", "gpt-5.4"),
        model("OpenAI", "GPT-5.4 mini", "openai", "gpt-5.4-mini"),
        model("OpenAI", "GPT-5.4 nano", "openai", "gpt-5.4-nano"),

        model("Anthropic", "Claude Fable 5", "anthropic", "claude-fable-5"),
        model("Anthropic", "Claude Opus 4.8", "anthropic", "claude-opus-4-8"),
        model("Anthropic", "Claude Sonnet 5", "anthropic", "claude-sonnet-5"),
        model("Anthropic", "Claude Haiku 4.5", "anthropic", "claude-haiku-4-5"),

        model("Google", "Gemini 3.5 Flash", "google", "gemini-3.5-flash"),
        model(
          "Google",
          "Gemini 3.1 Pro Preview",
          "google",
          "gemini-3.1-pro-preview",
        ),
        model(
          "Google",
          "Gemini 3.1 Flash-Lite",
          "google",
          "gemini-3.1-flash-lite",
        ),
      ],
    });
  }

  getModelParameters(rootDir: string): PropDefinition[] {
    // Wrap the whole lookup: in a browser/service-worker bundle there is no
    // filesystem (and `findPackageDts` itself touches `process`/`node:fs`), so
    // any failure falls back to the hardcoded defaults below.
    try {
      const dtsPath = findPackageDts("ai", "dist/index.d.ts", rootDir);
      if (dtsPath) {
        const sourceText = fs.readFileSync(dtsPath, "utf-8");
        const sourceFile = ts.createSourceFile(
          dtsPath,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
        );
        const decl = findTypeDeclaration(sourceFile, "CallSettings");
        if (decl)
          return extractPropertiesFromDeclaration(decl, sourceFile).definitions;
      }
    } catch {
      // fall through to hardcoded defaults
    }
    return FALLBACK_CALL_SETTINGS_PARAMS;
  }

  async executeConfig(
    config: any,
    { traceId, identity }: ExecuteConfigOptions = {},
  ): Promise<void> {
    // Import `ai` lazily so it stays an optional peer dependency: only users
    // who actually execute a Vercel AI SDK prompt need the package installed,
    // and execution runs against the consumer's own copy of `ai` (the same
    // instance their provider/model objects were built with).
    const { generateText } = await import("ai");

    let integration: PerTraceTelemetry | undefined;
    if (traceId) {
      // On v7, the `prompts()` helper may have swapped a per-call integration
      // (from `VercelAISDKTelemetry.createTelemetryForPrompt`) into `config.telemetry`.
      const integrations = toArray(config?.telemetry?.integrations);
      const i = integrations.findIndex(isPerPromptTelemetry);
      if (i >= 0) {
        integration = (integrations[i] as PerPromptTelemetry).withTraceId(
          traceId,
        );
        config = {
          ...config,
          telemetry: {
            ...config.telemetry,
            integrations: integrations.with(i, integration),
          },
        };
      } else {
        // No helper-provided integration (a raw config executed in the
        // playground). Bind the registered native telemetry to the route's
        // traceId so its spans land in the trace the route pre-created. Without
        // this the global fallback would record under its own freshly-minted id
        // — producing a *second*, anonymous trace alongside the empty one the
        // route created. The prompt provider passes the prompt `identity` so the
        // trace is still named and linked back to the prompt, even though this
        // config didn't go through the `prompts()` helper.
        const ingestor = await globalIngestionSetup;
        if (isVercelAISDKTelemetry(ingestor)) {
          integration = ingestor
            .createTelemetryForPrompt(identity)
            .withTraceId(traceId);
          config = {
            ...config,
            telemetry: {
              ...config.telemetry,
              // Drop the global instance from the per-call list (it would
              // double-record) and add the route-bound one.
              integrations: [
                ...integrations.filter(t => !isVercelAISDKTelemetry(t)),
                integration,
              ],
            },
          };
        }
      }
    }

    // Fire-and-forget: the route only needs the (already-known) traceId to
    // respond; the actual generation continues in the background and is
    // recorded via the attached telemetry integration's lifecycle events. A
    // rejection before any event fires (e.g. a bad model id) would otherwise
    // leave the pre-created trace hanging in `running` forever.
    generateText(config).catch((err: any) => {
      void integration?.fail(err?.message ?? String(err));
      console.error("prompt execution failed:", err);
    });
  }

  setupTraceIngestion(): Promise<TraceIngestor | undefined> {
    globalIngestionSetup ??= this.doSetupTraceIngestion();
    return globalIngestionSetup;
  }

  private async doSetupTraceIngestion(): Promise<TraceIngestor | undefined> {
    const ai = await import("ai");

    if (typeof ai.registerTelemetry === "function") {
      // v7+: native telemetry, no OTel detour needed.
      const telemetry = new VercelAISDKTelemetry();
      ai.registerTelemetry(telemetry);
      return telemetry;
    }

    // v6: stand up the global OTel pipeline so `experimental_telemetry`
    // spans land somewhere, and so async-context-propagated child spans
    // (e.g. from a wrapped tracer) are parented correctly. Shared with any
    // other SDK adapter that also needs OTel — it's set up at most once per
    // process.
    return setupGlobalOTelPipeline();
  }

  normalizePrompt(prompt: ParsedPrompt): NormalizedPrompt {
    const { definitions, values } = prompt.extractedProps;
    const modelValue = values?.[MODEL_KEY];
    const systemValue = values?.[SYSTEM_KEY];
    const messagesValue = values?.[MESSAGES_KEY];

    const modelParameters: NormalizedParameter[] = definitions
      .filter(d => !RESERVED_KEYS.has(d.name))
      .map(def => {
        const value = values?.[def.name];
        return {
          def,
          value,
          editable: value ? isEditable(value) : true,
        };
      });

    return {
      id: prompt.id,
      providerId: prompt.providerId,
      globalId: prompt.globalId,
      name: prompt.name,
      functionParameters: prompt.functionParameters,
      metadata: prompt.metadata,
      treePath: prompt.treePath,
      model: modelValue,
      modelEditable: modelValue ? isEditable(modelValue) : true,
      system: systemValue,
      systemEditable: systemValue ? isEditable(systemValue) : true,
      messages: extractMessages(messagesValue),
      messagesEditable: messagesValue ? isEditable(messagesValue) : true,
      modelParameters,
    };
  }

  denormalizeUpdates(
    updates: NormalizedPromptUpdates,
    _currentValues?: Record<string, PropValue>,
  ): Record<string, ModelPropValue | null> {
    const out: Record<string, ModelPropValue | null> = {};
    if (MODEL_KEY in updates) out[MODEL_KEY] = updates.model ?? null;
    if (SYSTEM_KEY in updates) out[SYSTEM_KEY] = updates.system ?? null;
    if (MESSAGES_KEY in updates) {
      out[MESSAGES_KEY] =
        updates.messages === null || updates.messages === undefined
          ? null
          : messagesToValue(updates.messages);
    }
    if (updates.modelParameters) {
      for (const [name, value] of Object.entries(updates.modelParameters)) {
        out[name] = value;
      }
    }
    return out;
  }
}

function messagesToValue(msgs: NormalizedMessage[]): PropValue {
  return {
    kind: "array",
    elements: msgs.map(msg => ({
      kind: "object",
      properties: {
        role: { kind: "primitive", value: msg.role },
        content: msg.content,
      },
    })),
  };
}

const EMPTY_CONTENT: PropValue = { kind: "primitive", value: "" };

function extractMessages(value: PropValue | undefined): NormalizedMessage[] {
  if (!value) return [];
  if (value.kind !== "array") return [{ role: "user", content: value }];
  return value.elements.map(el => {
    if (el.kind !== "object") return { role: "user", content: el };
    const roleValue = el.properties.role;
    const role =
      roleValue?.kind === "primitive" ? String(roleValue.value) : "user";
    const content = el.properties.content ?? EMPTY_CONTENT;
    const toolCalls = extractToolCalls(el.properties.toolCalls);
    return toolCalls ? { role, content, toolCalls } : { role, content };
  });
}

function extractToolCalls(
  value: PropValue | undefined,
): NormalizedToolCall[] | undefined {
  if (value?.kind !== "array") return undefined;
  const out: NormalizedToolCall[] = [];
  for (const el of value.elements) {
    if (el.kind !== "object") continue;
    const name = el.properties.toolName;
    const args = el.properties.args;
    out.push({
      toolName: name?.kind === "primitive" ? String(name.value) : "",
      args: args?.kind === "primitive" ? String(args.value) : "",
    });
  }
  return out.length > 0 ? out : undefined;
}
