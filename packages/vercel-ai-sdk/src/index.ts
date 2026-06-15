// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

/**
 * Helpers for integrating Vercel AI SDK prompts with Evalution.
 * @module @evalution/vercel-ai-sdk
 */
import { createRequire } from "node:module";
import type { generateText, streamText } from "ai";

// Bundled in by tsup; pulls just these symbols without taking a
// runtime dependency on the rest of the `evalution` package.
import {
  createTracerForPrompt,
  getPromptSpanAttributes,
  type PromptsFactory,
  type PromptsHelper,
  type PromptsHelperOptions,
} from "../../../src/trace/prompt-tracer.js";

const require = createRequire(import.meta.url);

import type { AmazonBedrockProvider } from "@ai-sdk/amazon-bedrock";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { AssemblyAIProvider } from "@ai-sdk/assemblyai";
import type { AzureOpenAIProvider } from "@ai-sdk/azure";
import type { CerebrasProvider } from "@ai-sdk/cerebras";
import type { CohereProvider } from "@ai-sdk/cohere";
import type { DeepgramProvider } from "@ai-sdk/deepgram";
import type { DeepInfraProvider } from "@ai-sdk/deepinfra";
import type { DeepSeekProvider } from "@ai-sdk/deepseek";
import type { ElevenLabsProvider } from "@ai-sdk/elevenlabs";
import type { FalProvider } from "@ai-sdk/fal";
import type { FireworksProvider } from "@ai-sdk/fireworks";
import type { GatewayProvider } from "@ai-sdk/gateway";
import type { GladiaProvider } from "@ai-sdk/gladia";
import type { GoogleGenerativeAIProvider } from "@ai-sdk/google";
import type { GoogleVertexProvider } from "@ai-sdk/google-vertex";
import type { GroqProvider } from "@ai-sdk/groq";
import type { HumeProvider } from "@ai-sdk/hume";
import type { LMNTProvider } from "@ai-sdk/lmnt";
import type { LumaProvider } from "@ai-sdk/luma";
import type { MistralProvider } from "@ai-sdk/mistral";
import type { OpenAIProvider } from "@ai-sdk/openai";
import type { PerplexityProvider } from "@ai-sdk/perplexity";
import type { ReplicateProvider } from "@ai-sdk/replicate";
import type { RevaiProvider } from "@ai-sdk/revai";
import type { TogetherAIProvider } from "@ai-sdk/togetherai";
import type { VercelProvider } from "@ai-sdk/vercel";
import type { XaiProvider } from "@ai-sdk/xai";

/**
 * Provider instances that can be injected into a {@link prompts} factory.
 * Each field matches the name of the singleton exported by the corresponding
 * `@ai-sdk/*` package (e.g. `openai` from `@ai-sdk/openai`).
 *
 * Only fields that are read are imported, so destructure only the ones you need.
 */
export interface Providers {
  /** `openai` from `@ai-sdk/openai` */
  openai: OpenAIProvider;
  /** `anthropic` from `@ai-sdk/anthropic` */
  anthropic: AnthropicProvider;
  /** `google` from `@ai-sdk/google` */
  google: GoogleGenerativeAIProvider;
  /** `vertex` from `@ai-sdk/google-vertex` */
  vertex: GoogleVertexProvider;
  /** `azure` from `@ai-sdk/azure` */
  azure: AzureOpenAIProvider;
  /** `bedrock` from `@ai-sdk/amazon-bedrock` */
  bedrock: AmazonBedrockProvider;
  /** `cohere` from `@ai-sdk/cohere` */
  cohere: CohereProvider;
  /** `mistral` from `@ai-sdk/mistral` */
  mistral: MistralProvider;
  /** `groq` from `@ai-sdk/groq` */
  groq: GroqProvider;
  /** `cerebras` from `@ai-sdk/cerebras` */
  cerebras: CerebrasProvider;
  /** `deepinfra` from `@ai-sdk/deepinfra` */
  deepinfra: DeepInfraProvider;
  /** `deepseek` from `@ai-sdk/deepseek` */
  deepseek: DeepSeekProvider;
  /** `fireworks` from `@ai-sdk/fireworks` */
  fireworks: FireworksProvider;
  /** `perplexity` from `@ai-sdk/perplexity` */
  perplexity: PerplexityProvider;
  /** `replicate` from `@ai-sdk/replicate` */
  replicate: ReplicateProvider;
  /** `togetherai` from `@ai-sdk/togetherai` */
  togetherai: TogetherAIProvider;
  /** `xai` from `@ai-sdk/xai` */
  xai: XaiProvider;
  /** `vercel` from `@ai-sdk/vercel` */
  vercel: VercelProvider;
  /** `gateway` from `@ai-sdk/gateway` */
  gateway: GatewayProvider;
  /** `elevenlabs` from `@ai-sdk/elevenlabs` */
  elevenlabs: ElevenLabsProvider;
  /** `assemblyai` from `@ai-sdk/assemblyai` */
  assemblyai: AssemblyAIProvider;
  /** `deepgram` from `@ai-sdk/deepgram` */
  deepgram: DeepgramProvider;
  /** `gladia` from `@ai-sdk/gladia` */
  gladia: GladiaProvider;
  /** `revai` from `@ai-sdk/revai` */
  revai: RevaiProvider;
  /** `luma` from `@ai-sdk/luma` */
  luma: LumaProvider;
  /** `fal` from `@ai-sdk/fal` */
  fal: FalProvider;
  /** `hume` from `@ai-sdk/hume` */
  hume: HumeProvider;
  /** `lmnt` from `@ai-sdk/lmnt` */
  lmnt: LMNTProvider;
}

class LazilyImportedProviders implements Providers {
  private readonly values: Partial<Providers>;

  constructor(values: Partial<Providers> = {}) {
    this.values = values;
  }

  private importProvider<K extends keyof Providers>(key: K): Providers[K] {
    return (
      this.values[key] ??
      require(`@ai-sdk/${key}`)?.[key] ??
      (() => {
        throw new Error(`Unable to import "${key}" from "@ai-sdk/${key}"`);
      })
    );
  }

  get openai() {
    return this.importProvider("openai");
  }
  get anthropic() {
    return this.importProvider("anthropic");
  }
  get google() {
    return this.importProvider("google");
  }
  get vertex() {
    return this.importProvider("vertex");
  }
  get azure() {
    return this.importProvider("azure");
  }
  get bedrock() {
    return this.importProvider("bedrock");
  }
  get cohere() {
    return this.importProvider("cohere");
  }
  get mistral() {
    return this.importProvider("mistral");
  }
  get groq() {
    return this.importProvider("groq");
  }
  get cerebras() {
    return this.importProvider("cerebras");
  }
  get deepinfra() {
    return this.importProvider("deepinfra");
  }
  get deepseek() {
    return this.importProvider("deepseek");
  }
  get fireworks() {
    return this.importProvider("fireworks");
  }
  get perplexity() {
    return this.importProvider("perplexity");
  }
  get replicate() {
    return this.importProvider("replicate");
  }
  get togetherai() {
    return this.importProvider("togetherai");
  }
  get xai() {
    return this.importProvider("xai");
  }
  get vercel() {
    return this.importProvider("vercel");
  }
  get gateway() {
    return this.importProvider("gateway");
  }
  get elevenlabs() {
    return this.importProvider("elevenlabs");
  }
  get assemblyai() {
    return this.importProvider("assemblyai");
  }
  get deepgram() {
    return this.importProvider("deepgram");
  }
  get gladia() {
    return this.importProvider("gladia");
  }
  get revai() {
    return this.importProvider("revai");
  }
  get luma() {
    return this.importProvider("luma");
  }
  get fal() {
    return this.importProvider("fal");
  }
  get hume() {
    return this.importProvider("hume");
  }
  get lmnt() {
    return this.importProvider("lmnt");
  }
}

/**
 * Re-exported from evalution: wraps a tracer so the spans it produces are
 * attributed to a named prompt. Used internally by {@link prompts} and exposed
 * for callers who configure `experimental_telemetry` themselves.
 */
export { createTracerForPrompt, getPromptSpanAttributes };

type GenerateTextConfig = Parameters<typeof generateText>[0];
type StreamTextConfig = Parameters<typeof streamText>[0];
type Prompt = GenerateTextConfig | StreamTextConfig; // | Agent<any, any, any>; // (agent not supported yet)

/**
 * Helper for defining Evalution prompt modules using the Vercel AI SDK.
 *
 * The first argument is a {@link PromptsHelperOptions} containing an `id` that,
 * combined with each prompt's name, forms a globally-unique prompt ID. This ID is
 * attached to every span the prompt produces so runtime traces can be resolved
 * back to the prompt. Choose a stable, unique value for this `id` and do not change it.
 *
 * The second argument is a factory function that receives a {@link Providers} object
 * and returns a record of prompt-building functions. Each key in the returned record
 * is the prompt name, and each value is a function that returns a Vercel AI SDK config object
 * (`generateText` / `streamText` parameters) with `experimental_telemetry`
 * automatically populated. The `Providers` object lazily imports provider singletons
 * (e.g. `openai` from `@ai-sdk/openai`) on first access, so only the providers you
 * destructure need to be installed. You can override individual providers by passing
 * a `Partial<{@link Providers}>` to the function returned by `prompts`.
 *
 * @example
 * ```ts
 * import { prompts } from "@evalution/vercel-ai-sdk";
 *
 * export default prompts(
 *   { id: "greeting" }, // <- global, unique ID for this group of prompts
 *
 *   // destructure provider functions you need here instead of importing them
 *   ({ openai }) => ({
 *
 *     // "simple" is the prompt name; result is passed to `generateText`
 *     simple: () => ({
 *        model: openai('gpt-4o'),
 *        system: 'You are a helpful assistant',
 *        messages: [{ role: 'user', content: 'Hello!' }],
 *     }),
 * }));
 * ```
 */
export const prompts = (<
  Prompts extends Record<string, (...args: any[]) => Prompt>,
>(
  { id }: PromptsHelperOptions,
  factory: (providers: Providers) => Prompts,
) =>
  (provided?: Partial<Providers>): Prompts => {
    const definitions = factory(new LazilyImportedProviders(provided));

    const wrapped = {} as any;
    for (const name of Object.keys(definitions)) {
      const define = definitions[name];
      wrapped[name] = (...args: any[]) => {
        const config = define(...args);

        // Agent instances aren't plain config objects — leave them untouched.
        if (!isPlainConfig(config)) return config;

        const existing = config.experimental_telemetry;
        return {
          ...config,
          experimental_telemetry: {
            isEnabled: true,

            // FIXME: Have options to disable these
            recordInputs: true,
            recordOutputs: true,

            ...existing,
            metadata: getPromptSpanAttributes(
              {
                name,
                id: `${id}#${name}`,
                functionParameters: args,
              },
              existing?.metadata,
            ),
          },
        };
      };
    }
    return wrapped;
  }) satisfies PromptsHelper;

/** True for plain config objects (i.e. not an `Agent` instance or nullish). */
function isPlainConfig(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
