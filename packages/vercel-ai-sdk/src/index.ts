import { createRequire } from "node:module";
import type { generateText, streamText, Agent } from "ai";
import type { Tracer } from "@opentelemetry/api";
// Bundled in by tsup; pulls in `createTracerForPrompt` without taking a
// runtime dependency on the rest of the `evalution` package.
import { createTracerForPrompt } from "../../../src/trace/prompt-tracer.js";

const require = createRequire(import.meta.url);

import type { OpenAIProvider } from "@ai-sdk/openai";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { GoogleGenerativeAIProvider } from "@ai-sdk/google";
import type { GoogleVertexProvider } from "@ai-sdk/google-vertex";
import type { AzureOpenAIProvider } from "@ai-sdk/azure";
import type { AmazonBedrockProvider } from "@ai-sdk/amazon-bedrock";
import type { CohereProvider } from "@ai-sdk/cohere";
import type { MistralProvider } from "@ai-sdk/mistral";
import type { GroqProvider } from "@ai-sdk/groq";
import type { CerebrasProvider } from "@ai-sdk/cerebras";
import type { DeepInfraProvider } from "@ai-sdk/deepinfra";
import type { DeepSeekProvider } from "@ai-sdk/deepseek";
import type { FireworksProvider } from "@ai-sdk/fireworks";
import type { PerplexityProvider } from "@ai-sdk/perplexity";
import type { ReplicateProvider } from "@ai-sdk/replicate";
import type { TogetherAIProvider } from "@ai-sdk/togetherai";
import type { XaiProvider } from "@ai-sdk/xai";
import type { VercelProvider } from "@ai-sdk/vercel";
import type { GatewayProvider } from "@ai-sdk/gateway";
import type { ElevenLabsProvider } from "@ai-sdk/elevenlabs";
import type { AssemblyAIProvider } from "@ai-sdk/assemblyai";
import type { DeepgramProvider } from "@ai-sdk/deepgram";
import type { GladiaProvider } from "@ai-sdk/gladia";
import type { RevaiProvider } from "@ai-sdk/revai";
import type { LumaProvider } from "@ai-sdk/luma";
import type { FalProvider } from "@ai-sdk/fal";
import type { HumeProvider } from "@ai-sdk/hume";
import type { LMNTProvider } from "@ai-sdk/lmnt";

/**
 * Provider instances that can be injected into a {@link prompts} factory.
 * Each field matches the name of the singleton exported by the corresponding
 * `@ai-sdk/*` package (e.g. `openai` from `@ai-sdk/openai`).
 *
 * Only fields that are read are imported — destructure only the ones you need.
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
    return this.values[key]
        ?? require(`@ai-sdk/${key}`)?.[key]
        ?? (() => { throw new Error(`Unable to import "${key}" from "@ai-sdk/${key}"`); });
  }

  get openai() { return this.importProvider('openai'); }
  get anthropic() { return this.importProvider('anthropic'); }
  get google() { return this.importProvider('google'); }
  get vertex() { return this.importProvider('vertex'); }
  get azure() { return this.importProvider('azure'); }
  get bedrock() { return this.importProvider('bedrock'); }
  get cohere() { return this.importProvider('cohere'); }
  get mistral() { return this.importProvider('mistral'); }
  get groq() { return this.importProvider('groq'); }
  get cerebras() { return this.importProvider('cerebras'); }
  get deepinfra() { return this.importProvider('deepinfra'); }
  get deepseek() { return this.importProvider('deepseek'); }
  get fireworks() { return this.importProvider('fireworks'); }
  get perplexity() { return this.importProvider('perplexity'); }
  get replicate() { return this.importProvider('replicate'); }
  get togetherai() { return this.importProvider('togetherai'); }
  get xai() { return this.importProvider('xai'); }
  get vercel() { return this.importProvider('vercel'); }
  get gateway() { return this.importProvider('gateway'); }
  get elevenlabs() { return this.importProvider('elevenlabs'); }
  get assemblyai() { return this.importProvider('assemblyai'); }
  get deepgram() { return this.importProvider('deepgram'); }
  get gladia() { return this.importProvider('gladia'); }
  get revai() { return this.importProvider('revai'); }
  get luma() { return this.importProvider('luma'); }
  get fal() { return this.importProvider('fal'); }
  get hume() { return this.importProvider('hume'); }
  get lmnt() { return this.importProvider('lmnt'); }
}

/**
 * Re-exported from evalution: wraps a tracer so the spans it produces are
 * attributed to a named prompt. Used internally by {@link prompts} and exposed
 * for callers who configure `experimental_telemetry` themselves.
 */
export { createTracerForPrompt };

type GenerateTextConfig = Parameters<typeof generateText>[0];
type StreamTextConfig = Parameters<typeof streamText>[0];
type Prompt = GenerateTextConfig | StreamTextConfig; // | Agent<any, any, any>; // (agent not supported yet)

/**
 * Type helper for defining evalution prompt modules using the Vercel AI SDK.
 *
 * The first argument is a module-level ID that, combined with each prompt's
 * name, forms a globally-unique prompt ID (`${moduleId}#${name}`). This ID is
 * attached to every span the prompt produces so runtime traces can be resolved
 * back to the prompt. Choose a stable, opaque value — it should survive file
 * renames and moves.
 *
 * @example
 * ```ts
 * import { prompts } from '@evalution/vercel-ai-sdk';
 *
 * export default prompts('greeting', ({ openai }) => ({
 *   simplePrompt() {
 *     return {
 *       model: openai('gpt-4o'),
 *       system: 'You are a helpful assistant',
 *       messages: [{ role: 'user', content: 'Hello!' }],
 *     };
 *   },
 * }));
 * ```
 */
export function prompts<T extends Record<string, (...args: any[]) => Prompt>>(
  id: string,
  factory: (providers: Providers) => T,
): (providers?: Partial<Providers>) => T {
  return provided => {
    const definitions = factory(new LazilyImportedProviders(provided));

    const wrapped = {} as T;
    for (const key of Object.keys(definitions) as (keyof T)[]) {
      const define = definitions[key];
      wrapped[key] = ((...args: Parameters<T[keyof T]>) => {
        const config = define(...args);

        // Agent instances aren't plain config objects — leave them untouched.
        if (!isPlainConfig(config)) return config;

        const name = String(key);
        const existing = config.experimental_telemetry;

        return {
          ...config,
          experimental_telemetry: {
            isEnabled: true,
            recordInputs: true,
            recordOutputs: true,
            ...existing,

            tracer: createTracerForPrompt({ name, id: `${id}#${name}` }, existing?.tracer),
          },
        };
      }) as T[keyof T];
    }
    return wrapped;
  };
}

/** True for plain config objects (i.e. not an `Agent` instance or nullish). */
function isPlainConfig(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
