// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs";
import type { PropDefinition, PropValue } from "ts-proppy";
import {
  extractPropertiesFromDeclaration,
  findTypeDeclaration,
} from "ts-proppy";
import ts from "typescript";
import type {
  ProbeResult,
  ProbeResults,
  TypeExpressionProbe,
  TypeProbe,
} from "../../prompt/file/prompt-file-type.ts";
import {
  CONFIG_FILE_RELATIVE_PATH,
  type SetupTask,
} from "../../shared/setup-task.ts";
import type {
  NormalizedChatPrompt,
  NormalizedMessage,
  NormalizedParameter,
  NormalizedPromptUpdates,
  NormalizedToolCall,
  ParsedPrompt,
} from "../../shared/types.ts";
import { setupGlobalOTelPipeline } from "../../trace/otel-global-pipeline.ts";
import type { TraceIngestor } from "../../trace/trace-ingestor.ts";
import {
  assertUpdateStyle,
  type ExecuteConfigOptions,
  type ExecutionHandle,
  findPackageDts,
  isMissingPackage,
  missingPackageMessage,
  type SDKAdapter,
} from "../sdk-adapter.ts";
import {
  MODEL_PROJECT_PROBES,
  PROMPTS_HELPER_CALL,
  vercelModelDefinition,
} from "./model-definition.ts";
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
const TOOLS_KEY = "tools";

/** How the `toolsContext` type is labelled in the UI, resolved or not. */
const TOOLS_CONTEXT_SYNTAX = "InferToolSetContext<typeof tools>";
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
      element: {
        name: "",
        type: { kind: "primitive", syntax: "string" },
        optional: false,
      },
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

/** Thrown by {@link importAI} when the `ai` package isn't installed. */
class MissingAIPackageError extends Error {}

/**
 * Imports the consumer's copy of `ai`, turning "not installed" into an
 * actionable message. Keeping the bare specifier in one place also keeps it
 * legible to the bundler, which is configured never to bundle `ai`.
 */
async function importAI(): Promise<typeof import("ai")> {
  try {
    return await import("ai");
  } catch (err) {
    if (isMissingPackage(err, "ai"))
      throw new MissingAIPackageError(missingPackageMessage("ai"), {
        cause: err,
      });
    throw err;
  }
}

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

  getProjectProbes(language: string): TypeProbe[] {
    return language === "typescript" ? MODEL_PROJECT_PROBES : [];
  }

  async getModelDefinition(project: ProbeResults): Promise<PropDefinition> {
    return vercelModelDefinition(project);
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

  /**
   * The per-tool context object that `generateText` requires whenever a tool
   * declares a `contextSchema`.
   */
  private static readonly TOOLS_CONTEXT_PROBE: TypeExpressionProbe = {
    kind: "type",
    name: "toolsContext",
    description:
      "Per-tool context required by tools that declare a contextSchema.",
    // Reached entirely through `ai`'s own public surface, and deliberately so.
    // `InferToolSetContext` lives in `@ai-sdk/provider-utils`, but naming that
    // package directly resolves whichever copy the *prompt file* sees, which
    // is not necessarily the one `ai` was built against — `ai` bundles its own.
    // Going through `generateText` gets the SDK's semantics from the same
    // module the prompt's config is destined for.
    //
    // Defensive by construction: a config with no `tools`, or tools that
    // declare no context, makes `toolsContext` `never`/optional and the whole
    // expression collapses to `never`, yielding no parameter. That is also how
    // tools without a `contextSchema` are dropped — no filtering logic of ours.
    expression:
      '$config extends { tools: infer T extends import("ai").ToolSet } ' +
      '? NonNullable<Parameters<typeof import("ai").generateText<T>>[0]["toolsContext"]> ' +
      ": never",
    // The checker spells the resolved type as a deeply-instantiated
    // `Normalize<RequiredToolSetContext<…>>`, which is accurate and unreadable.
    syntax: TOOLS_CONTEXT_SYNTAX,
  };

  getPromptProbes(_prompt: ParsedPrompt, language: string): TypeProbe[] {
    // The expression above is plainly TypeScript; an adapter should say so
    // rather than emit it for a language that cannot evaluate it.
    if (language !== "typescript") return [];
    return [VercelAISDK.TOOLS_CONTEXT_PROBE];
  }

  async executeConfig(
    config: any,
    { traceId, identity, executeValues }: ExecuteConfigOptions = {},
  ): Promise<ExecutionHandle> {
    // Import `ai` lazily so it stays an optional peer dependency: only users
    // who actually execute a Vercel AI SDK prompt need the package installed,
    // and execution runs against the consumer's own copy of `ai` (the same
    // instance their provider/model objects were built with).
    const { generateText } = await importAI();

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

    // Execute parameters are merged here rather than by the caller: they are
    // top-level `generateText` arguments for this SDK, but that is this
    // adapter's fact to know, not a general rule about where a named run-time
    // value belongs.
    if (executeValues && Object.keys(executeValues).length > 0) {
      config = { ...config, ...executeValues };
    }

    // Fire-and-forget: the route only needs the (already-known) traceId to
    // respond; the actual generation continues in the background and is
    // recorded via the attached telemetry integration's lifecycle events. A
    // rejection before any event fires (e.g. a bad model id) would otherwise
    // leave the pre-created trace hanging in `running` forever.
    //
    // `done` settles either way, and never rejects: a caller awaiting it (to
    // dispose run-scoped resources, say) only needs to know the run is over,
    // and the failure has already been reported through the trace.
    const done = generateText(config).then(
      () => undefined,
      (err: any) => {
        void integration?.fail(err?.message ?? String(err));
        console.error("prompt execution failed:", err);
      },
    );

    return { done };
  }

  setupTraceIngestion(): Promise<TraceIngestor | undefined> {
    globalIngestionSetup ??= this.doSetupTraceIngestion();
    return globalIngestionSetup;
  }

  private async doSetupTraceIngestion(): Promise<TraceIngestor | undefined> {
    let ai: typeof import("ai");
    try {
      ai = await importAI();
    } catch (err) {
      if (!(err instanceof MissingAIPackageError)) throw err;
      // `ai` is optional: without it there is nothing to trace, but the rest of
      // the playground (browsing and editing prompts) still works, so warn
      // instead of taking the CLI down at startup. Executing a prompt reports
      // the same message through the normal execution-error path.
      console.warn(`⚠️ ${err.message}`);
      return undefined;
    }

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

  normalizePrompt(
    prompt: ParsedPrompt,
    resolvedProbes?: readonly ProbeResult[],
  ): NormalizedChatPrompt {
    const { definitions, values } = prompt.extractedProps;
    const modelValue = values?.[MODEL_KEY];
    const systemValue = values?.[SYSTEM_KEY];
    const messagesValue = values?.[MESSAGES_KEY];

    const modelParameters: NormalizedParameter[] = definitions
      .filter(d => !RESERVED_KEYS.has(d.name))
      .map(def => ({ def, value: values?.[def.name] }));

    const executeParameters = this.executeParametersFor(prompt, resolvedProbes);

    return {
      style: "chat",
      id: prompt.id,
      providerId: prompt.providerId,
      globalId: prompt.globalId,
      name: prompt.name,
      functionParameters: prompt.functionParameters,
      metadata: prompt.metadata,
      treePath: prompt.treePath,
      model: modelValue,
      // Capabilities of the SDK: `generateText` takes any model, system
      // message and message list. Whether a particular value parsed into an
      // editable shape is the editor's question, not this adapter's.
      modelEditable: true,
      system: systemValue,
      systemEditable: true,
      messages: extractMessages(messagesValue),
      messagesEditable: true,
      modelParameters,
      executeParameters,
      // `toolsContext` fans out per tool because the AI SDK resolves tools
      // individually, not because prompt authors think in terms of separate
      // contexts — `odin/index.ts` builds one object and hands the same
      // reference to every tool. That is this adapter's fact to know, so it
      // says so rather than leaving the panel to guess from the data.
      inputLayout: executeParameters && {
        executeSlots: { [VercelAISDK.TOOLS_CONTEXT_PROBE.name]: "combined" },
      },
    };
  }

  /**
   * Assemble the prompt's execute parameters from what the probes resolved to.
   *
   * The interesting case is the third one. When no probe could run — a file
   * type with no checker, an in-memory provider, a resolution failure — the
   * parameter is still declared, with an unresolved type. "This prompt needs
   * `toolsContext` and I cannot tell you its shape" is a usable state; staying
   * silent reproduces exactly the failure this machinery exists to prevent,
   * where the first tool call dies at run time with nothing having warned you.
   *
   * That degradation is scoped by a cheap syntactic check — does the config
   * even have a `tools` property? — so a prompt that plainly has no tools does
   * not sprout a mystery parameter.
   */
  private executeParametersFor(
    prompt: ParsedPrompt,
    resolvedProbes?: readonly ProbeResult[],
  ): PropDefinition[] | undefined {
    const resolved = resolvedProbes?.[0];
    if (resolved && !Array.isArray(resolved)) return [resolved];
    // `null` is a definite "this prompt needs no context" — never degrade it.
    if (resolved === null) return undefined;

    const hasTools = prompt.extractedProps.definitions.some(
      d => d.name === TOOLS_KEY,
    );
    if (!hasTools) return undefined;

    return [
      {
        name: VercelAISDK.TOOLS_CONTEXT_PROBE.name,
        description: VercelAISDK.TOOLS_CONTEXT_PROBE.description,
        type: { kind: "opaque", syntax: TOOLS_CONTEXT_SYNTAX },
        optional: false,
      },
    ];
  }

  denormalizeUpdates(
    updates: NormalizedPromptUpdates,
    _currentValues?: Record<string, PropValue>,
  ): Record<string, PropValue | null> {
    assertUpdateStyle(updates, "chat");
    const out: Record<string, PropValue | null> = {};
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
