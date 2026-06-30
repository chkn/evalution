// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
//
// This file is dual-licensed. As shipped inside the AGPL-licensed `evalution`
// core it is covered by AGPL-3.0-only; as bundled into the MIT-licensed
// `@evalution/vercel-ai-sdk` package it is covered by MIT. Keep this file
// self-contained — it must import nothing from the rest of the core, or the
// MIT bundle would pull AGPL-only code into an MIT artifact. See LICENSING.md.
import {
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
  trace,
} from "@opentelemetry/api";

export interface PromptsHelperOptions {
  /**
   * Globally-unique identifier for this group of prompts.
   */
  readonly id: string;
}

export type PromptsFactory<Args extends any[] = never[], Prompt = unknown> = (
  ...args: Args
) => Record<string, (...args: any[]) => Prompt>;

/**
 * Intended to be used in the `satisfies` clause of a `prompts` export from an
 * SDK adapter package.
 */
export type PromptsHelper = (
  opts: PromptsHelperOptions,
  factory: PromptsFactory<any[], any>,
) => PromptsFactory<any[], any>;

/**
 * Attribute name a span can set to pick one of evalution's span-kind values
 * (`'LLM'`, `'TOOL'`, `'AGENT'`, `'EMBEDDING'`, `'DEFAULT'`). Falls back to
 * `'DEFAULT'` when absent or unrecognised.
 */
export const SPAN_KIND_ATTRIBUTE = "evalution.span.type";

/**
 * Attribute name a span can set to give a human-readable name to the prompt.
 */
export const PROMPT_NAME_ATTRIBUTE = "gen_ai.prompt.name";

/**
 * Attribute name a span can set to link itself to a specific prompt. The value
 * is a globally-unique prompt ID unless {@link PROMPT_PROVIDER_ID_ATTRIBUTE} is
 * also set, in which case it is scoped to that provider.
 */
export const PROMPT_ID_ATTRIBUTE = "evalution.prompt.id";

/**
 * Attribute name a span can set to scope its {@link PROMPT_ID_ATTRIBUTE} to a
 * specific prompt provider. When absent, the prompt ID is treated as global.
 */
export const PROMPT_PROVIDER_ID_ATTRIBUTE = "evalution.prompt.provider.id";

/**
 * Attribute name a span can set to include an array of input parameters used
 * to construct the final prompt.
 */
export const PROMPT_INPUTS_ATTRIBUTE = "evalution.prompt.inputs";

export interface PromptSpanInfo {
  /** Globally-unique prompt id (e.g. `${groupId}#${name}`). */
  id?: string;
  /** Human-readable prompt name. */
  name: string;
  /** Positional arguments the prompt function was called with. */
  functionParameters?: unknown[];
}

export function getPromptSpanAttributes(
  prompt: PromptSpanInfo,
  attributes: Attributes = {},
): Record<string, AttributeValue> {
  return Object.fromEntries(
    [
      [SPAN_KIND_ATTRIBUTE, "LLM"],
      [PROMPT_NAME_ATTRIBUTE, prompt.name],
      [PROMPT_ID_ATTRIBUTE, prompt.id],
      [PROMPT_INPUTS_ATTRIBUTE, prompt.functionParameters],
      ...Object.entries(attributes),
    ].filter(([, v]) => v !== undefined && v !== null),
  );
}

/**
 * Wraps a {@link Tracer} so that every span it produces is tagged with the
 * attributes that associate it with a prompt — the prompt's name
 * ({@link PROMPT_NAME_ATTRIBUTE}), an optional global prompt ID
 * ({@link PROMPT_ID_ATTRIBUTE}), and an `'LLM'` span kind
 * ({@link SPAN_KIND_ATTRIBUTE}). Attributes set explicitly on an individual
 * span take precedence over these defaults.
 *
 * This depends only on `@opentelemetry/api`, so it can be re-used by SDK
 * adapter packages (e.g. `@evalution/vercel-ai-sdk`) without pulling in the
 * rest of evalution.
 *
 * @param prompt - The prompt to attribute spans to. `name` is a human-readable
 *   name; the optional `id` is a globally-unique prompt ID used to resolve
 *   runtime traces back to the prompt.
 * @param tracer - Tracer to wrap. Defaults to a tracer from the globally
 *   registered tracer provider.
 * @returns A tracer that forwards to `tracer` while attaching the prompt
 *   attributes to each span it creates.
 */
export function createTracerForPrompt(
  prompt: PromptSpanInfo,
  tracer?: Tracer,
): Tracer {
  const inner = tracer ?? trace.getTracer("evalution");

  const withPromptAttributes = (options?: SpanOptions): SpanOptions => ({
    ...options,
    attributes: getPromptSpanAttributes(prompt, options?.attributes),
  });

  return {
    startSpan(name: string, options?: SpanOptions, context?: Context): Span {
      return inner.startSpan(name, withPromptAttributes(options), context);
    },

    startActiveSpan(name: string, ...rest: any[]): any {
      // Mirror the three `startActiveSpan` overloads:
      //   (name, fn) | (name, options, fn) | (name, options, context, fn)
      if (typeof rest[0] === "function") {
        return inner.startActiveSpan(name, withPromptAttributes(), rest[0]);
      }
      if (typeof rest[1] === "function") {
        return inner.startActiveSpan(
          name,
          withPromptAttributes(rest[0]),
          rest[1],
        );
      }
      return inner.startActiveSpan(
        name,
        withPromptAttributes(rest[0]),
        rest[1],
        rest[2],
      );
    },
  };
}
