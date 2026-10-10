// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * One prompt run: inputs resolved, receipts stamped, trace id minted,
 * `onSettled` wired. Shared by the execute route and the eval runner, so the
 * two can't drift apart. See `specs/evals.md` §D.1.
 */

import {
  isSpanContextValid,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import {
  inputReferenceProblems,
  namedBindings,
  type ResolutionContext,
  resolveExecutionInputs,
  stampReceipts,
} from "../prompt/execution-inputs.ts";
import type {
  PromptProvider,
  ResolvedPromptInputs,
} from "../prompt/prompt-provider.ts";
import type {
  ExecuteRequest,
  ExecuteResponse,
  ExecutionInput,
  NormalizedPrompt,
  PromptRef,
  RunResources,
} from "../shared/types.ts";

/**
 * The inputs couldn't be turned into values — an unknown slot, a cycle, a
 * resource that no longer exists. Nothing was dispatched and there's no trace
 * to carry the error, so the route answers it as a bad request.
 */
export class InputResolutionError extends Error {
  override name = "InputResolutionError";
}

/** Options for {@link runPrompt}. */
export interface RunPromptOptions {
  tracer: Tracer;
  /** The trace provider the run's trace lands on. */
  traceProviderId: string;
  /**
   * What `dataset` references resolve against. The run's own bindings are
   * always supplied for `input` references.
   */
  row?: ResolutionContext["row"];
  /**
   * Keep the run's lease after it settles, for the caller to
   * {@link ResolvedPromptInputs.release} — an eval runs its checks first.
   * By default the lease is released as soon as the run settles.
   */
  holdLease?: boolean;
}

/** What {@link runPrompt} returns. */
export interface RunPromptResult {
  /** What the execute route answers. */
  response: ExecuteResponse;
  /** The run's resolution, lease included. */
  resolved: ResolvedPromptInputs;
  /** Resolves once the run is over, successfully or not. */
  settled: Promise<void>;
}

/**
 * Runs `prompt` once with `inputs`. Resolves once the run is dispatched — the
 * generation continues in the background, and {@link RunPromptResult.settled}
 * says when it's over.
 *
 * @throws {InputResolutionError} When the inputs name a slot that doesn't
 * exist, form a cycle, or otherwise can't be resolved.
 */
export async function runPrompt(
  provider: PromptProvider,
  ref: PromptRef,
  prompt: Pick<
    NormalizedPrompt,
    "name" | "functionParameters" | "executeParameters"
  >,
  request: ExecuteRequest,
  options: RunPromptOptions,
): Promise<RunPromptResult> {
  const inputs: {
    functionInputs: ExecutionInput[];
    executeInputs: Record<string, ExecutionInput>;
    resources?: RunResources;
  } = {
    functionInputs: [...(request.functionInputs ?? [])],
    executeInputs: { ...request.executeInputs },
    ...(request.resources && { resources: { ...request.resources } }),
  };

  // The request is itself a complete set of bindings, so `input` references
  // resolve against it (`specs/evals.md` §B.2.1). Unknown targets — a slot
  // the prompt lacks, an instance the run doesn't declare — and cycles are
  // refused before anything is created.
  const bindings = namedBindings(prompt.functionParameters, inputs);
  const problems = inputReferenceProblems(bindings, prompt);
  if (problems.length > 0) {
    throw new InputResolutionError(problems.join("; "));
  }
  const context: ResolutionContext = {
    bindings,
    ...(options.row && { row: options.row }),
  };

  // Inputs arrive unresolved, so resolution happens here — server-side,
  // where a resource can actually be created and where a value's import
  // bindings can actually be imported. A provider that offers non-value
  // sources interprets its own `uri` grammar through `resolveInputs`; every
  // other provider gets the value-only fallback and never has to know an
  // `ExecutionInput` exists.
  let resolved: ResolvedPromptInputs;
  try {
    resolved = provider.resolveInputs
      ? await provider.resolveInputs(ref, inputs, context)
      : {
          ...(await resolveExecutionInputs(inputs, undefined, context)),
          resolveMore: async more => {
            const { executeValues } = await resolveExecutionInputs(
              { executeInputs: more },
              undefined,
              context,
            );
            return executeValues;
          },
        };
  } catch (err: any) {
    throw new InputResolutionError(err?.message ?? String(err));
  }
  const { functionParams, executeValues } = resolved;
  // What actually gets recorded on the trace: the request as sent, with each
  // resource instance's receipt filled in from what this run's resolution
  // produced — see `specs/resource-arguments.md` §K.
  const recordedResources = stampReceipts(inputs.resources, resolved.receipts);
  const recordedInputs = {
    functionInputs: inputs.functionInputs,
    executeInputs: inputs.executeInputs,
    ...(recordedResources && { resources: recordedResources }),
  };

  let settle!: () => void;
  const settled = new Promise<void>(resolve => {
    settle = resolve;
  });
  const onSettled = () => {
    if (!options.holdLease) void resolved.release?.();
    settle();
  };

  const response = await options.tracer.startActiveSpan(
    prompt.name,
    async span => {
      const ctx = span.spanContext();
      // On the native (v7) path no OTel tracer provider is registered, so the
      // no-op tracer hands back the all-zero *invalid* span context — the
      // same value for every call. Mint our own unique id then, and name the
      // root span the way the native ingestor does (`${traceId}:root`) so the
      // client's initial span selection resolves. On the OTel/v6 path the
      // span context is real and must be reused: the OTel ingestor records
      // its spans under that same trace id.
      const native = !isSpanContextValid(ctx);
      const traceId = native ? crypto.randomUUID() : ctx.traceId;
      const rootSpanId = native ? `${traceId}:root` : ctx.spanId;

      // The trace is created lazily by the telemetry ingestor when the root
      // span starts. A client that opens the returned trace id before then
      // polls `GET /api/traces/:p/:id` until it appears.
      let ran: Awaited<ReturnType<PromptProvider["execute"]>>;
      try {
        ran = await provider.execute(ref, functionParams, {
          traceId,
          rootSpanId,
          executeValues,
          inputs: recordedInputs,
          // Run-scoped resources outlive the dispatch: `execute` returns as
          // soon as the run is dispatched, so teardown hangs off completion.
          onSettled,
        });
      } catch (err: any) {
        void resolved.release?.();
        settle();
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
        tracerProviderId: options.traceProviderId,
        ...(ran?.version && { version: ran.version }),
        ...(ran?.variation && { variation: ran.variation }),
      } satisfies ExecuteResponse;
    },
  );

  return { response, resolved, settled };
}
