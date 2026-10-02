// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral handlers for listing, reading, and executing prompts —
 * resolved providers in, {@link HandlerResult} out — shared by the
 * `/api/prompts` routes and the MCP server.
 */

import { isSpanContextValid, SpanStatusCode } from "@opentelemetry/api";
import { valueToSourceText } from "ts-proppy";
import {
  resolveExecutionInputs,
  stampReceipts,
} from "../../prompt/execution-inputs.ts";
import {
  type PromptProvider,
  type ResolvedPromptInputs,
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

    const { functionInputs = [], executeInputs = {} } = request ?? {};
    const prompt = await provider.getPrompt(ref);
    if (!prompt) return errorResult(404, "Prompt not found");

    // Inputs arrive unresolved, so resolution happens here — server-side,
    // where a resource can actually be created and where a value's import
    // bindings can actually be imported. A provider that offers non-value
    // sources interprets its own `uri` grammar through `resolveInputs`;
    // every other provider gets the value-only fallback and never has to
    // know an `ExecutionInput` exists.
    const inputs = { functionInputs, executeInputs };
    let resolved: ResolvedPromptInputs;
    try {
      resolved = provider.resolveInputs
        ? await provider.resolveInputs(ref, inputs)
        : { ...(await resolveExecutionInputs(inputs)), release: undefined };
    } catch (err: any) {
      // The request named something that cannot be turned into a value — a
      // dataset cell, a resource that no longer exists. That is a bad
      // request, not a failed run: nothing has been dispatched and no trace
      // exists to carry the error, so it has to be answered here — and
      // logged, since the response carries only the message.
      console.error("failed to resolve prompt inputs:", err);
      return errorResult(400, err?.message ?? String(err));
    }
    const { functionParams, executeValues } = resolved;
    // What actually gets recorded on the trace: the request as sent, with
    // each resource reference's receipt filled in from what this run's
    // resolution produced — see `specs/resource-arguments.md` §K. A receipt
    // arriving on a replay request already survived resolution above
    // (`resolveInputs` passes it to `create`); this is what makes the *new*
    // run's own receipt the one a later replay of *this* trace would see.
    const recordedInputs = stampReceipts(inputs, resolved.receipts);

    let markSettled!: () => void;
    const settled = new Promise<void>(resolve => {
      markSettled = resolve;
    });

    const response = await tracer.startActiveSpan(prompt.name, async span => {
      const ctx = span.spanContext();
      // On the native (v7) path no OTel tracer provider is registered, so the
      // no-op tracer hands back the all-zero *invalid* span context — the same
      // value for every call. Mint our own unique id then, and name the root
      // span the way the native ingestor does (`${traceId}:root`) so the
      // client's initial span selection resolves. On the OTel/v6 path the span
      // context is real and must be reused: the OTel ingestor records its
      // spans under that same trace id.
      const native = !isSpanContextValid(ctx);
      const traceId = native ? crypto.randomUUID() : ctx.traceId;
      const rootSpanId = native ? `${traceId}:root` : ctx.spanId;

      // The trace is created lazily by the telemetry ingestor when the root
      // span starts. A client that opens the returned trace id before then
      // polls `GET /api/traces/:p/:id` until it appears (see the client's
      // `getTrace`), so no server-side pre-creation is needed.
      let ran: Awaited<ReturnType<PromptProvider["execute"]>>;
      try {
        ran = await provider.execute(ref, functionParams, {
          traceId,
          rootSpanId,
          executeValues,
          inputs: recordedInputs,
          // Run-scoped resources outlive this response: `execute` returns as
          // soon as the run is dispatched, so teardown hangs off completion
          // rather than off the request.
          onSettled: () => {
            void resolved.release?.();
            markSettled();
          },
        });
      } catch (err: any) {
        void resolved.release?.();
        console.error("prompt execution failed:", err);
        span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err?.error
            ? JSON.stringify(err.error, null, 2)
            : (err?.message ?? String(err)),
        });
        span.end();
        throw err;
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return {
        traceId,
        rootSpanId,
        tracerProviderId: defaultTraceProviderId,
        ...(ran?.version && { version: ran.version }),
        ...(ran?.variation && { variation: ran.variation }),
      } satisfies ExecuteResponse;
    });

    return { status: 200, body: response, settled };
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

function summarizeParameter(def: PropDefinition): ParameterSummary {
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
