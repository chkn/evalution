// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

/**
 * Helpers for integrating TypeSafe System One prompts with Evalution.
 * @module @evalution/typesafe-sdk
 */
import { type Span, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type {
  Questions,
  SystemOneRequest,
  SystemOneResult,
  TypeSafeClient,
} from "@typesafe-ai/sdk";

// Bundled in by tsdown, so the package takes no runtime dependency on the
// rest of `evalution`.
import {
  PROMPT_IDENTITY,
  promptIdentityOf,
  systemOneErrorMessage,
  systemOneRequestAttributes,
  systemOneResultAttributes,
} from "../../../src/sdk/typesafe-sdk/telemetry.js";
import {
  createTracerForPrompt,
  type PromptSpanInfo,
  type PromptsHelper,
  type PromptsHelperOptions,
} from "../../../src/trace/prompt-tracer.js";

export { PROMPT_IDENTITY, type PromptSpanInfo };

/** A prompt function: builds a System One request from its arguments. */
export type Prompt = (...args: any[]) => SystemOneRequest<any>;

/**
 * Defines a module of System One prompts that Evalution can edit, run and
 * trace.
 *
 * The first argument's `id`, combined with each prompt's name, forms a
 * globally-unique prompt ID that links runtime traces back to the prompt.
 * Choose a stable value and don't change it.
 *
 * Each request is returned exactly as its prompt function built it — the same
 * type, so answer types are still inferred from its questions — carrying the
 * prompt's identity under the {@link PROMPT_IDENTITY} symbol. A symbol, not a
 * property: the request is sent to the API as-is, and a symbol survives a
 * spread (`{ ...request, model }`) but is never serialized.
 *
 * @example
 * ```ts
 * import { choice, noul } from "@typesafe-ai/sdk";
 * import { prompts } from "@evalution/typesafe-sdk";
 *
 * export default prompts({ id: "support-triage" }, () => ({
 *   triage: (ticket: Ticket, product: string) => ({
 *     state: { ticket },
 *     questions: {
 *       refund_requested: noul(`Does the customer ask for a refund for ${product}?`),
 *       team: choice("Which team should handle this?", { billing: "Payments and refunds", technical: null }),
 *     },
 *   }),
 * }));
 * ```
 */
export const prompts = (<Prompts extends Record<string, Prompt>>(
  { id }: PromptsHelperOptions,
  factory: () => Prompts,
) =>
  (): Prompts => {
    const definitions = factory();
    const wrapped = {} as Record<string, Prompt>;
    for (const name of Object.keys(definitions)) {
      const define = definitions[name];
      wrapped[name] = (...args: any[]) => {
        const request = define(...args);
        if (!request || typeof request !== "object") return request;
        const identity: PromptSpanInfo = {
          name,
          id: `${id}#${name}`,
          functionParameters: args,
        };
        // Enumerable, so a spread keeps it.
        return Object.defineProperty({ ...request }, PROMPT_IDENTITY, {
          value: identity,
          enumerable: true,
        });
      };
    }
    return wrapped as Prompts;
  }) satisfies PromptsHelper;

/** Options for {@link instrument}. */
export interface InstrumentOptions {
  /**
   * The tracer spans are started from. Defaults to one from the globally
   * registered OpenTelemetry tracer provider.
   */
  tracer?: Tracer;
}

/** The `systemOne` wrappers {@link instrument} has installed. */
const instrumentedCalls = new WeakSet<TypeSafeClient["systemOne"]>();

/**
 * Records a client's System One calls as OpenTelemetry spans that Evalution
 * links back to their prompts.
 *
 * Only a request built by {@link prompts} — one carrying a prompt identity —
 * is recorded; any other call passes straight through. The client is changed
 * in place and returned. Instrumenting a client that already is does nothing,
 * so its calls aren't recorded twice.
 *
 * A recorded call's result is read to record it, so don't also consume the
 * raw body with `asResponse()` on the same call.
 */
export function instrument<C extends TypeSafeClient>(
  client: C,
  { tracer }: InstrumentOptions = {},
): C {
  if (instrumentedCalls.has(client.systemOne)) return client;
  const systemOne = client.systemOne.bind(client);
  const instrumented: typeof client.systemOne = (request, options) => {
    const identity = promptIdentityOf(request);
    if (!identity) return systemOne(request, options);

    const span: Span = createTracerForPrompt(identity, tracer).startSpan(
      "systemOne",
      {
        attributes: systemOneRequestAttributes(
          request as SystemOneRequest<Questions>,
          client.defaultModel,
        ),
      },
    );
    const call = systemOne(request, options);
    call.then(
      result => {
        span.setAttributes(
          systemOneResultAttributes(result as SystemOneResult<Questions>),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      },
      err => {
        const message = systemOneErrorMessage(err);
        span.recordException(err instanceof Error ? err : message);
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.end();
      },
    );
    return call;
  };
  instrumentedCalls.add(instrumented);
  client.systemOne = instrumented;
  return client;
}
