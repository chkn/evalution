// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
//
// This file is dual-licensed. As shipped inside the AGPL-licensed `evalution`
// core it is covered by AGPL-3.0-only; as bundled into the MIT-licensed
// `@evalution/typesafe-sdk` package it is covered by MIT. Keep this file
// self-contained — it must import nothing from the rest of the core, only the
// dual-licensed `src/trace/` glue and a type-only `@typesafe-ai/sdk` import.
// See LICENSING.md.

import type {
  Questions,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk"; // type-only: keeps the SDK an optional peer dep
import type { PromptSpanInfo } from "../../trace/prompt-tracer.ts";
import { BaseTraceIngestor } from "../../trace/trace-ingestor.ts";
import type { LLMSpanDetails, Span } from "../../trace/trace-types.ts";

/**
 * The key under which the `prompts()` helper attaches a config's prompt
 * identity. A symbol, because a System One request object is sent to the API
 * as-is: a string key would be sent along and fail validation, while a symbol
 * survives a spread and is dropped by `JSON.stringify`.
 */
export const PROMPT_IDENTITY = Symbol.for("evalution.prompt");

/** The provider name recorded on System One spans. */
export const TYPESAFE_PROVIDER = "typesafe";

/** The prompt identity a config carries, if the `prompts()` helper attached one. */
export function promptIdentityOf(config: unknown): PromptSpanInfo | undefined {
  if (!config || typeof config !== "object") return undefined;
  return (config as { [PROMPT_IDENTITY]?: PromptSpanInfo })[PROMPT_IDENTITY];
}

/** What a System One call is given, as a span's `llm.input`. */
export function systemOneInput(request: SystemOneRequest<Questions>): {
  state: unknown;
  questions: unknown;
} {
  return { state: request.state, questions: request.questions };
}

/** What a System One call returned, as span LLM details. */
export function systemOneResultDetails(
  result: SystemOneResult<Questions>,
): LLMSpanDetails {
  const { input_tokens, output_tokens } = result.usage ?? {};
  return {
    provider: TYPESAFE_PROVIDER,
    model: result.model,
    output: result.answers,
    ...(input_tokens !== undefined && { promptTokens: input_tokens }),
    ...(output_tokens !== undefined && { completionTokens: output_tokens }),
    ...(input_tokens !== undefined &&
      output_tokens !== undefined && {
        totalTokens: input_tokens + output_tokens,
      }),
  };
}

/**
 * A failed call's message. The SDK's own errors already say what went wrong —
 * a 422's message lists the invalid fields — so they're used as they are.
 */
export function systemOneErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** OTel attribute carrying an LLM call's input as JSON, for inputs that aren't messages. */
export const LLM_INPUT_ATTRIBUTE = "evalution.llm.input";

/** OTel attribute carrying an LLM call's output as JSON. */
export const LLM_OUTPUT_ATTRIBUTE = "evalution.llm.output";

/** OTel attributes describing a System One request, for the span that records it. */
export function systemOneRequestAttributes(
  request: SystemOneRequest<Questions>,
  defaultModel?: string,
): Record<string, string> {
  const model = request.model ?? defaultModel;
  return {
    "gen_ai.provider.name": TYPESAFE_PROVIDER,
    "gen_ai.operation.name": "chat",
    ...(model && { "gen_ai.request.model": model }),
    [LLM_INPUT_ATTRIBUTE]: JSON.stringify(systemOneInput(request)),
  };
}

/** OTel attributes describing a System One result. */
export function systemOneResultAttributes(
  result: SystemOneResult<Questions>,
): Record<string, string | number> {
  return {
    "gen_ai.response.model": result.model,
    "gen_ai.output.type": "json",
    [LLM_OUTPUT_ATTRIBUTE]: JSON.stringify(result.answers),
    ...(result.usage && {
      "gen_ai.usage.input_tokens": result.usage.input_tokens,
      "gen_ai.usage.output_tokens": result.usage.output_tokens,
    }),
  };
}

/** One System One call being recorded. See {@link TypeSafeTelemetry.startCall}. */
export interface SystemOneCallRecord {
  /** Records the call's result and ends its span. */
  end(result: SystemOneResult<Questions>): Promise<void>;
  /** Records the call's failure and ends its span as an error. */
  fail(err: unknown): Promise<void>;
}

/** Options for {@link TypeSafeTelemetry.startCall}. */
export interface SystemOneCallOptions {
  /** The trace to record into. */
  traceId: string;
  /** The span's ID; defaults to the trace's conventional root span ID. */
  spanId?: string;
  /** The prompt the call was made for, if known. */
  identity?: PromptSpanInfo;
  /** The request, recorded as the span's input. */
  request: SystemOneRequest<Questions>;
  /** The model the request will be answered by, if the request doesn't say. */
  defaultModel?: string;
}

/**
 * Records System One calls as `LLM` spans. The SDK has no telemetry hook, so
 * the adapter (in the playground) and `instrument()` (at run time) call it
 * around each `systemOne` call.
 */
export class TypeSafeTelemetry extends BaseTraceIngestor {
  /** Starts a span for a call; the returned record ends it. */
  async startCall({
    traceId,
    spanId = `${traceId}:root`,
    identity,
    request,
    defaultModel,
  }: SystemOneCallOptions): Promise<SystemOneCallRecord> {
    const start: Span = {
      id: spanId,
      traceId,
      name: identity?.id ?? identity?.name ?? "systemOne",
      kind: "LLM",
      startTime: Date.now(),
      llm: {
        provider: TYPESAFE_PROVIDER,
        model: request.model ?? defaultModel,
        input: systemOneInput(request),
      },
      prompt: identity?.id
        ? {
            id: identity.id,
            functionParameters: identity.functionParameters,
            functionInputs: identity.functionInputs,
            executeInputs: identity.executeInputs,
            parameterDefinitions: identity.parameterDefinitions,
          }
        : undefined,
    };
    await this.recordSpanStart(start);

    return {
      end: result =>
        this.recordSpanEnd({
          ...start,
          endTime: Date.now(),
          status: "ok",
          llm: { ...start.llm, ...systemOneResultDetails(result) },
        }),
      fail: err =>
        this.recordSpanEnd({
          ...start,
          endTime: Date.now(),
          status: "error",
          errorMessage: systemOneErrorMessage(err),
        }),
    };
  }
}
