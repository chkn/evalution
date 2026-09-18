// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  PropDefinition,
  PropValue,
  ValueCatalog,
  ValueCatalogGroup,
  ValueFactory,
} from "ts-proppy";
import type {
  ProbeResult,
  ProbeResults,
  TypeProbe,
} from "../../prompt/file/prompt-file-type.ts";
import {
  CONFIG_FILE_RELATIVE_PATH,
  type SetupTask,
} from "../../shared/setup-task.ts";
import type {
  NormalizedPromptUpdates,
  NormalizedQuestionsPrompt,
  ParsedPrompt,
} from "../../shared/types.ts";
import {
  assertUpdateStyle,
  type ExecuteConfigOptions,
  type ExecutionHandle,
  isMissingPackage,
  missingPackageMessage,
  type SDKAdapter,
} from "../sdk-adapter.ts";
import { TYPESAFE_FALLBACK } from "./fallback.ts";
import { PROBE, TYPESAFE_PACKAGE, TYPESAFE_PROJECT_PROBES } from "./probes.ts";
import { promptIdentityOf, TypeSafeTelemetry } from "./telemetry.ts";

// Type-only: the SDK is an optional peer dependency, imported lazily.
type TypeSafeClient = import("@typesafe-ai/sdk").TypeSafeClient;
type TypeSafeClientConfig = import("@typesafe-ai/sdk").TypeSafeClientConfig;
type SystemOneRequest = import("@typesafe-ai/sdk").SystemOneRequest;

// Module-level, like the other adapters' ingestors: every TypeSafe adapter
// records into the one ingestor the server has connected sinks to.
let globalTelemetry: TypeSafeTelemetry | undefined;

/**
 * Imports the consumer's copy of the SDK, turning "not installed" into an
 * actionable message. Only projects that execute TypeSafe prompts need it.
 */
async function importTypeSafe(): Promise<typeof import("@typesafe-ai/sdk")> {
  try {
    return await import("@typesafe-ai/sdk");
  } catch (err) {
    if (isMissingPackage(err, TYPESAFE_PACKAGE)) {
      throw new Error(missingPackageMessage(TYPESAFE_PACKAGE), { cause: err });
    }
    throw err;
  }
}

/** Starter contents of `.evalution/config.ts` for TypeSafe. */
const CONFIG_FILE_CONTENTS = `import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider, TypeSafeSDK } from 'evalution';

// Running prompts needs a TypeSafe API key: set TYPESAFE_API_KEY in the
// environment you start evalution from.
export default {
  promptProviders: [
    new FilePromptProvider({
      sdk: new TypeSafeSDK(),
    }),
  ],
} satisfies EvalutionConfig;
`;

const MODEL_KEY = "model";
const STATE_KEY = "state";
const QUESTIONS_KEY = "questions";

/** The model the SDK uses when neither the request nor the client names one. */
const SDK_DEFAULT_MODEL = "jev-latest";

/** Friendlier labels for the SDK's own question factories. */
const FACTORY_LABELS: Record<string, string> = {
  noul: "Yes / no",
  choice: "Choice",
  score: "Score",
};

/** Options for {@link TypeSafeSDK}. */
export interface TypeSafeSDKOptions {
  /**
   * Configuration for the `TypeSafeClient` this adapter builds to list models
   * and execute prompts. Defaults to the SDK's own (API key and base URL from
   * the environment).
   */
  client?: TypeSafeClientConfig;
}

/** A probe's definition, or the checked-in snapshot's when it didn't resolve. */
function definition(
  project: ProbeResults,
  name: string,
): PropDefinition | undefined {
  const pick = (result: ProbeResult) =>
    result && !Array.isArray(result) ? result : undefined;
  return pick(project[name]) ?? pick(TYPESAFE_FALLBACK[name]);
}

/** The question factories found in the installed SDK, or the snapshot's. */
function questionFactories(project: ProbeResults): ValueFactory[] {
  const found = project[PROBE.factories];
  if (Array.isArray(found)) return found;
  const fallback = TYPESAFE_FALLBACK[PROBE.factories];
  return Array.isArray(fallback) ? fallback : [];
}

/**
 * The `questions` definition with the SDK's question factories offered for
 * each question: a catalog group per factory, bound to an import from the SDK.
 */
function questionsDefinition(project: ProbeResults): PropDefinition {
  const def = definition(project, PROBE.questions) ?? {
    name: QUESTIONS_KEY,
    type: { kind: "opaque", syntax: "Questions" },
    optional: false,
  };
  if (def.type.kind !== "record") return def;

  const groups: ValueCatalogGroup[] = questionFactories(project).map(
    factory => ({
      label: FACTORY_LABELS[factory.def.name] ?? factory.def.name,
      factory,
    }),
  );
  const catalog: ValueCatalog = { label: "Questions", groups };
  return {
    ...def,
    name: QUESTIONS_KEY,
    type: {
      ...def.type,
      value: { ...def.type.value, catalogs: [catalog] },
    },
  };
}

/**
 * {@link SDKAdapter} implementation for [TypeSafe](https://typesafe.ai)'s
 * System One models (`@typesafe-ai/sdk`).
 *
 * A System One request isn't a chat: it asks a set of named, typed questions
 * about a `state`. So its prompts are normalized to the `questions` style,
 * whose editor is built around the questions rather than a message list.
 *
 * Every type the editor needs — the state, the questions, and the factories
 * that build them — is read from the installed SDK through project probes, so
 * a question type added by a later SDK version is editable without an
 * Evalution release.
 */
export class TypeSafeSDK implements SDKAdapter {
  readonly promptsHelperImport = "@evalution/typesafe-sdk";

  /**
   * Onboarding task: install the SDK and the prompts helper, then drop a
   * starter config.
   * @internal
   */
  static readonly setupTask: SetupTask = {
    id: "typesafe-sdk",
    label: "TypeSafe",
    icon: "TypeSafe",
    steps: [
      {
        kind: "install_package",
        id: "install-typesafe-sdk",
        package: TYPESAFE_PACKAGE,
      },
      {
        kind: "install_package",
        id: "install-evalution-typesafe-sdk",
        package: "@evalution/typesafe-sdk",
      },
      {
        kind: "create_config",
        id: "create-config",
        path: CONFIG_FILE_RELATIVE_PATH,
        contents: CONFIG_FILE_CONTENTS,
      },
    ],
  };

  private readonly clientConfig: TypeSafeClientConfig | undefined;
  private modelIds: Promise<string[]> | undefined;
  private clientPromise: Promise<TypeSafeClient> | undefined;

  constructor({ client }: TypeSafeSDKOptions = {}) {
    this.clientConfig = client;
  }

  /** The model a request without one is answered by. */
  private get defaultModel(): string {
    return (
      this.clientConfig?.defaultModel ??
      (process.env.TYPESAFE_DEFAULT_MODEL?.trim() || SDK_DEFAULT_MODEL)
    );
  }

  getProjectProbes(language: string): TypeProbe[] {
    return language === "typescript" ? TYPESAFE_PROJECT_PROBES : [];
  }

  /**
   * A model name, with the account's models from `client.models.list()` as
   * presets. Listing needs an API key and the network, so it falls back to the
   * default model alone.
   */
  async getModelDefinition(project: ProbeResults): Promise<PropDefinition> {
    const def = definition(project, PROBE.model) ?? {
      name: MODEL_KEY,
      type: { kind: "primitive", syntax: "string", base: "string" },
      optional: true,
    };
    const ids = await this.listModels();
    return {
      ...def,
      name: MODEL_KEY,
      optional: true,
      // A request without a model is answered by the client's default.
      defaultValue: { kind: "primitive", value: this.defaultModel },
      catalogs: [
        {
          label: "Models",
          groups: [
            {
              label: "TypeSafe",
              icon: "TypeSafe",
              presets: ids.map(id => ({
                label: id,
                value: { kind: "primitive", value: id },
              })),
            },
          ],
          literal: true,
        },
      ],
    };
  }

  /** Model names from the API, listed once per adapter. */
  private listModels(): Promise<string[]> {
    this.modelIds ??= (async () => {
      try {
        const { TypeSafeClient } = await importTypeSafe();
        const client = new TypeSafeClient({
          ...this.clientConfig,
          logLevel: "off",
        });
        const cards = await client.models.list({
          timeout: 5000,
          retry: { maxRetries: 0 },
        });
        const names = cards.map(card => card.name);
        return names.length > 0 ? names : [this.defaultModel];
      } catch {
        // No key, no network, or no SDK: the default model is still a model.
        // Forget the failure, so the next call tries again rather than pinning
        // the picker to one model until the server restarts. Safe to clear
        // unconditionally: no newer promise can exist while this one is set.
        this.modelIds = undefined;
        return [this.defaultModel];
      }
    })();
    return this.modelIds;
  }

  /** Per-call options are transport settings, not prompt content. */
  getModelParameters(): PropDefinition[] {
    return [];
  }

  normalizePrompt(
    prompt: ParsedPrompt,
    _promptProbes?: readonly ProbeResult[],
    project: ProbeResults = {},
  ): NormalizedQuestionsPrompt {
    const values = prompt.extractedProps.values;
    const stateDef = definition(project, PROBE.state) ?? {
      name: STATE_KEY,
      type: { kind: "opaque", syntax: "EntryType" },
      optional: false,
    };
    return {
      style: "questions",
      id: prompt.id,
      providerId: prompt.providerId,
      globalId: prompt.globalId,
      name: prompt.name,
      functionParameters: prompt.functionParameters,
      metadata: prompt.metadata,
      treePath: prompt.treePath,
      model: values?.[MODEL_KEY],
      // Capabilities of `systemOne`: any model, state and questions.
      modelEditable: true,
      modelParameters: [],
      state: {
        def: { ...stateDef, name: STATE_KEY },
        value: values?.[STATE_KEY],
      },
      stateEditable: true,
      questions: {
        def: questionsDefinition(project),
        value: values?.[QUESTIONS_KEY],
      },
      questionsEditable: true,
    };
  }

  /**
   * Nearly the identity: a System One config's `model`, `state` and
   * `questions` are the normalized fields, already in source shape.
   */
  denormalizeUpdates(
    updates: NormalizedPromptUpdates,
  ): Record<string, PropValue | null> {
    assertUpdateStyle(updates, "questions");
    const out: Record<string, PropValue | null> = {};
    if ("model" in updates) out[MODEL_KEY] = updates.model ?? null;
    if ("state" in updates) out[STATE_KEY] = updates.state ?? null;
    if ("questions" in updates) out[QUESTIONS_KEY] = updates.questions ?? null;
    return out;
  }

  /**
   * Calls `systemOne` with the config, recording it as the run's root span.
   *
   * Resolves as soon as the call is dispatched; the returned handle's `done`
   * settles when it finishes, successfully or not.
   */
  async executeConfig(
    config: SystemOneRequest,
    { traceId, rootSpanId, identity }: ExecuteConfigOptions = {},
  ): Promise<ExecutionHandle> {
    const client = await this.client();
    const telemetry = await this.setupTraceIngestion();
    const call = traceId
      ? await telemetry.startCall({
          traceId,
          spanId: rootSpanId,
          identity: promptIdentityOf(config) ?? identity,
          request: config,
          defaultModel: client.defaultModel,
        })
      : undefined;

    // `systemOne` validates its questions synchronously, so a bad config
    // throws rather than rejecting; either way it belongs in the trace.
    const done = Promise.resolve()
      .then(() => client.systemOne(config))
      .then(
        async result => {
          await call?.end(result);
        },
        async err => {
          await call?.fail(err);
          console.error("prompt execution failed:", err);
        },
      );
    return { done };
  }

  /** The client executions use, built once. */
  private client(): Promise<TypeSafeClient> {
    if (!this.clientPromise) {
      const pending = importTypeSafe().then(
        ({ TypeSafeClient }) => new TypeSafeClient(this.clientConfig),
      );
      this.clientPromise = pending;
      // A client that failed to build (a missing key, say) shouldn't stay
      // broken once the environment is fixed.
      pending.catch(() => {
        if (this.clientPromise === pending) this.clientPromise = undefined;
      });
    }
    return this.clientPromise;
  }

  setupTraceIngestion(): Promise<TypeSafeTelemetry> {
    globalTelemetry ??= new TypeSafeTelemetry();
    return Promise.resolve(globalTelemetry);
  }
}
