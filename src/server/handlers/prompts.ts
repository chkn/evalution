// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral handlers for listing, reading, and executing prompts —
 * resolved providers in, {@link HandlerResult} out — shared by the
 * `/api/prompts` routes and the MCP server.
 */

import { valueToSourceText } from "ts-proppy";
import {
  type PromptProvider,
  VariationConflictError,
} from "../../prompt/prompt-provider.ts";
import type {
  ExecuteRequest,
  ExecuteResponse,
  NormalizedPrompt,
  PromptRef,
  PropDefinition,
} from "../../shared/types.ts";
import type { ApiContext } from "../api-context.ts";
import { InputResolutionError, runPrompt } from "../run-prompt.ts";
import { errorResult, type HandlerResult } from "./result.ts";

/**
 * The result for an error from a prompt, versions, or variations call: a
 * conflict is a 409 carrying the conflicting fields, so the client can show
 * them; anything else gets `status`.
 */
export function promptFailure(error: any, status: number): HandlerResult {
  if (error instanceof VariationConflictError) {
    return {
      status: 409,
      body: { error: error.message, conflicts: error.conflicts },
    };
  }
  return errorResult(status, error?.message ?? String(error));
}

/** `GET /api/prompts` — every prompt of every provider. */
export async function handleListPrompts(
  promptProviders: Map<string, PromptProvider>,
): Promise<HandlerResult> {
  try {
    const results = await Promise.all(
      Array.from(promptProviders.entries()).map(
        async ([providerId, provider]) => {
          const prompts = await provider.getAllPrompts();
          return prompts.map(prompt => ({ ...prompt, providerId }));
        },
      ),
    );
    return { status: 200, body: results.flat() };
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/** `GET /api/prompts/:providerId/:id` — one prompt, at `ref`. */
export async function handleGetPrompt(
  provider: PromptProvider,
  ref: PromptRef,
): Promise<HandlerResult> {
  try {
    const prompt = await provider.getPrompt(ref);
    if (!prompt) return errorResult(404, "Prompt not found");
    return { status: 200, body: { ...prompt, providerId: provider.id } };
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/** What {@link handleExecutePrompt} returns. */
export interface ExecutePromptResult extends HandlerResult {
  /**
   * Settles once the run is over, successfully or not. Present only when the
   * run was dispatched — the result itself answers as soon as it is, with the
   * run continuing in the background.
   */
  settled?: Promise<void>;
}

/**
 * `POST /api/prompts/:providerId/:id/execute` — starts a run of the prompt
 * at `ref` on `provider` (`undefined` when the request named none that
 * exists), answering with an {@link ExecuteResponse} (the trace to watch) as
 * soon as it's dispatched.
 */
export async function handleExecutePrompt(
  context: Pick<
    ApiContext,
    "tracer" | "defaultTraceProviderId" | "executeDisabledMessage"
  >,
  provider: PromptProvider | undefined,
  ref: PromptRef,
  request: ExecuteRequest,
): Promise<ExecutePromptResult> {
  const { tracer, defaultTraceProviderId, executeDisabledMessage } = context;
  try {
    // Hosts that can't run prompts (e.g. the in-browser demo) disable
    // execution and surface a message the client renders as an error.
    if (executeDisabledMessage) return errorResult(400, executeDisabledMessage);
    if (!provider) return errorResult(404, "Provider not found");

    const prompt = await provider.getPrompt(ref);
    if (!prompt) return errorResult(404, "Prompt not found");

    let run: Awaited<ReturnType<typeof runPrompt>>;
    try {
      run = await runPrompt(
        provider,
        ref,
        prompt,
        {
          functionInputs: request?.functionInputs ?? [],
          executeInputs: request?.executeInputs ?? {},
          ...(request?.resources && { resources: request.resources }),
        },
        { tracer, traceProviderId: defaultTraceProviderId },
      );
    } catch (err) {
      // The request named something that cannot be turned into a value — a
      // dataset cell, an unknown slot, a resource that no longer exists.
      // That is a bad request, not a failed run: nothing has been dispatched
      // and no trace exists to carry the error, so it has to be answered
      // here — and logged, since the response carries only the message.
      if (!(err instanceof InputResolutionError)) throw err;
      console.error("failed to resolve prompt inputs:", err);
      return errorResult(400, err.message);
    }
    return { status: 200, body: run.response, settled: run.settled };
  } catch (error: any) {
    return promptFailure(error, 500);
  }
}

/** One parameter of a {@link PromptSummary}. */
export interface ParameterSummary {
  name: string;
  /** The parameter's TypeScript type, as written. */
  type: string;
  optional: boolean;
  description?: string;
}

/**
 * A prompt described for someone deciding which to run and how to call it:
 * where it lives, what it takes, and what it's set to — with values as the
 * source text they're written as, rather than as `PropValue` trees.
 */
export interface PromptSummary {
  providerId: string;
  id: string;
  name: string;
  /** The author-supplied stable id, if any. */
  globalId?: string;
  style: NormalizedPrompt["style"];
  /** The absolute path of the file the prompt is defined in, when it has one. */
  sourcePath?: string;
  /** The model, as source text. */
  model?: string;
  /** Positional arguments, in order. */
  functionParameters: ParameterSummary[];
  /** Named values running the prompt needs beyond its arguments. */
  executeParameters?: ParameterSummary[];
  /** Model parameter name → its value as source text. */
  modelParameters?: Record<string, string>;
  /** True when the prompt has unsaved edits (a WIP variation) at head. */
  dirty?: boolean;
}

/** A parameter as a {@link PromptSummary} lists it. */
export function summarizeParameter(def: PropDefinition): ParameterSummary {
  return {
    name: def.name,
    type: def.type.syntax,
    optional: def.optional,
    ...(def.description && { description: def.description }),
  };
}

/** `prompt` as a {@link PromptSummary}. */
export function summarizePrompt(
  provider: PromptProvider,
  prompt: NormalizedPrompt,
): PromptSummary {
  const sourcePath = provider.getSourcePath?.(prompt);
  const modelParameters = Object.fromEntries(
    prompt.modelParameters
      .filter(p => p.value !== undefined)
      .map(p => [p.def.name, valueToSourceText(p.value!)]),
  );
  return {
    providerId: provider.id,
    id: prompt.id,
    name: prompt.name,
    ...(prompt.globalId && { globalId: prompt.globalId }),
    style: prompt.style,
    ...(sourcePath && { sourcePath }),
    ...(prompt.model && { model: valueToSourceText(prompt.model) }),
    functionParameters: prompt.functionParameters.map(summarizeParameter),
    ...(prompt.executeParameters?.length && {
      executeParameters: prompt.executeParameters.map(summarizeParameter),
    }),
    ...(Object.keys(modelParameters).length > 0 && { modelParameters }),
    ...(prompt.dirty && { dirty: true }),
  };
}
