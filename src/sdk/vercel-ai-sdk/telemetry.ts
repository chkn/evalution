// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
//
// This file is dual-licensed. As shipped inside the AGPL-licensed `evalution`
// core it is covered by AGPL-3.0-only; as bundled into the MIT-licensed
// `@evalution/vercel-ai-sdk` package it is covered by MIT. Keep this file
// self-contained — it must import nothing from the rest of the core, only the
// dual-licensed `src/trace/` glue and a type-only `ai` import. See LICENSING.md.

import type { ModelMessage, Telemetry } from "ai"; // type-only: keeps `ai` an optional peer dep

import type { PromptSpanInfo } from "../../trace/prompt-tracer.ts";

type Arrayable<T> = T | T[];

import { makeBrand } from "../../brand.ts";
import { BaseTraceIngestor } from "../../trace/trace-ingestor.ts";
import type { Span, SpanMessage } from "../../trace/trace-types.ts";

export interface PerPromptTelemetry extends Telemetry {
  /**
   * Returns a new instance that will use the given trace ID.
   */
  withTraceId(traceId: string): PerTraceTelemetry;
}
const { brand: brandPerPrompt, isBranded: isPerPromptTelemetry } =
  makeBrand<PerPromptTelemetry>(
    Symbol.for("evalution.VercelAISDKTelemetry.PerPromptTelemetry"),
  );

export { isPerPromptTelemetry };

export interface PerTraceTelemetry extends PerPromptTelemetry {
  /**
   * Marks this run's trace as failed. Used by `executeConfig` to surface a
   * `generateText` rejection that happens before `onStart` fires (e.g. a
   * bad model id) — without this, the trace pre-created for the route's
   * synchronous response would otherwise hang in `running` forever. If spans
   * were already opened before the rejection, they are closed as `error` too.
   */
  fail(message: string): Promise<void>;
}

const { brand: brandTelemetry, isBranded: isVercelAISDKTelemetry } =
  makeBrand<VercelAISDKTelemetry>(Symbol.for("evalution.VercelAISDKTelemetry"));

export { isVercelAISDKTelemetry };

export interface VercelAISDKTelemetryOptions {
  /**
   * Native telemetry collection: `"auto"` (default) collects natively unless
   * an OpenTelemetry integration is also active for the call, in which case
   * it defers to OTel; `"always"` forces native telemetry collection, even
   * alongside OTel; `"never"` always defers.
   */
  nativeTelemetry?: "auto" | "always" | "never";
}

function toSpanMessages(messages: ModelMessage[]): SpanMessage[] | undefined {
  return messages.map(msg => {
    const role = msg.role;
    const content = msg.content;
    if (typeof content === "string") return { role, content };
    const text = content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");
    return { role, content: text };
  });
}

export function toArray<T>(v: Arrayable<T> | undefined) {
  return v === undefined ? [] : Array.isArray(v) ? [...v] : [v];
}

type Callbacks = Required<Telemetry>;

/**
 * Per-call run state, keyed by the v7 event `callId`. Holds the open spans of
 * one in-flight generation so lifecycle events can be matched to the span they
 * close — tools by `toolCallId` (they may run in parallel), the step and root
 * by position.
 */
interface RunState {
  readonly traceId: string;
  /** The root span; closed by `onEnd`. */
  readonly root: Span;
  /** The current step span, if one is open; closed by `onStepEnd`. */
  step?: Span;
  /** Open tool spans keyed by `toolCallId`, so concurrent tools stay distinct. */
  readonly tools: Map<string, Span>;
}

/**
 * Native v7 AI SDK `Telemetry` integration that records evalution traces
 * without going through OpenTelemetry.
 *
 * When your app starts, register this globally via `registerTelemetry(new Evalution())` to capture
 * every `generateText`/`streamText` call as a fallback (events are keyed by
 * `callId`, so concurrent calls stay correctly separated, though the fallback
 * lacks prompt identity). The `prompts()` helper additionally swaps in a
 * per-call integration from {@link createTelemetryForPrompt} so
 * helper-defined prompts are recorded with full identity.
 *
 * When an OpenTelemetry integration is also active, this class
 * defers to it by default (see {@link VercelAISDKTelemetryOptions.nativeTelemetry}) rather
 * than emitting a duplicate, parallel trace.
 */
export class VercelAISDKTelemetry
  extends BaseTraceIngestor
  implements Telemetry
{
  /**
   * This instance's configured {@link VercelAISDKTelemetryOptions.nativeTelemetry}.
   * Read by the `prompts()` helper to decide whether to defer to a sibling
   * OpenTelemetry integration for a given call.
   */
  readonly nativeTelemetry: "auto" | "always" | "never";
  private readonly runs = new Map<string, RunState>();

  constructor(options: VercelAISDKTelemetryOptions = {}) {
    super();
    this.nativeTelemetry = options.nativeTelemetry ?? "auto";
    brandTelemetry(this);
  }

  private shouldDeferGlobally(): boolean {
    if (this.nativeTelemetry === "always") return false;
    if (this.nativeTelemetry === "never") return true;
    // ensure we update if other cases are added in the future
    const _auto: "auto" = this.nativeTelemetry;
    const integrations = toArray(globalThis.AI_SDK_TELEMETRY_INTEGRATIONS);
    return integrations.some(i => i?.constructor?.name === "OpenTelemetry");
  }

  // ── Telemetry interface: global fallback (no prompt identity) ──────────

  onStart: Callbacks["onStart"] = event =>
    this.shouldDeferGlobally() ? undefined : this.handleStart(event);
  onStepStart: Callbacks["onStepStart"] = event => this.handleStepStart(event);
  onToolExecutionStart: Callbacks["onToolExecutionStart"] = event =>
    this.handleToolExecutionStart(event);
  onToolExecutionEnd: Callbacks["onToolExecutionEnd"] = event =>
    this.handleToolExecutionEnd(event);
  onStepEnd: Callbacks["onStepEnd"] = event => this.handleStepEnd(event);
  onEnd: Callbacks["onEnd"] = event => this.handleEnd(event);
  onAbort: Callbacks["onAbort"] = event => this.handleAbort(event);

  /**
   * Mints a `PerPromptTelemetry` integration bound to the given prompt identity.
   * Used by the `prompts()` helper so a helper-defined prompt is recorded with
   * full identity. Called with no `identity` (e.g. by the playground for a raw,
   * non-helper config) it still binds a trace id but records without prompt
   * identity — the same data the global fallback would, just under a known id.
   */
  createTelemetryForPrompt(identity?: PromptSpanInfo): PerPromptTelemetry {
    const perPromptTelemetry: PerPromptTelemetry = brandPerPrompt({
      onStart: event => this.handleStart(event, { identity }),
      onStepStart: event => this.handleStepStart(event),
      onToolExecutionStart: event => this.handleToolExecutionStart(event),
      onToolExecutionEnd: event => this.handleToolExecutionEnd(event),
      onStepEnd: event => this.handleStepEnd(event),
      onEnd: event => this.handleEnd(event),
      onAbort: event => this.handleAbort(event),
      // The brand is non-enumerable, so the spread below drops it — the result
      // is re-branded by `brandPerPrompt`.
      withTraceId: traceId =>
        brandPerPrompt({
          ...perPromptTelemetry,
          onStart: event => this.handleStart(event, { identity, traceId }),
          fail: message => this.handleFail(traceId, message),
        }),
    });
    return perPromptTelemetry;
  }

  // ── Shared event handlers ───────────────────────────────────────────────

  private async handleStart(
    event: Parameters<Callbacks["onStart"]>[0],
    {
      identity,
      traceId = crypto.randomUUID(),
    }: { identity?: PromptSpanInfo; traceId?: string } = {},
  ): Promise<void> {
    const startTime = Date.now();
    const name = identity?.name ?? event.operationId ?? "generation";

    const span: Span = {
      id: `${traceId}:root`,
      traceId,
      name,
      kind: "AGENT",
      startTime,
      llm: {
        provider: event.provider,
        model: event.modelId,
      },
      prompt: identity?.id
        ? {
            id: identity.id,
            functionParameters: identity.functionParameters,
          }
        : undefined,
    };

    this.runs.set(event.callId, { traceId, root: span, tools: new Map() });

    // The root span's `recordSpanStart` creates the `running` trace; no
    // separate pre-creation step is needed.
    await this.recordSpanStart(span);
  }

  private async handleStepStart(
    event: Parameters<Callbacks["onStepStart"]>[0],
  ): Promise<void> {
    const run = this.runs.get(event.callId);
    if (!run) return;

    const messages = toSpanMessages(event.messages);
    const span: Span = {
      id: crypto.randomUUID(),
      traceId: run.traceId,
      parentId: run.root.id,
      name: `step: ${event.stepNumber}`,
      kind: "LLM",
      startTime: Date.now(),
      llm: {
        provider: event.provider,
        model: event.modelId,
        messages,
      },
    };
    run.step = span;
    await this.recordSpanStart(span);
  }

  private async handleToolExecutionStart(
    event: Parameters<Callbacks["onToolExecutionStart"]>[0],
  ): Promise<void> {
    const run = this.runs.get(event.callId);
    if (!run) return;

    // Tools belong to the current step (or the root, if a tool is somehow
    // reported outside a step). Parenting to `run.step` rather than "the most
    // recently opened span" keeps parallel tool calls siblings under the step.
    const parentSpan = run.step ?? run.root;
    const span: Span = {
      id: crypto.randomUUID(),
      traceId: run.traceId,
      parentId: parentSpan.id,
      name: `tool: ${event.toolCall.toolName}`,
      kind: "TOOL",
      startTime: Date.now(),
      tool: {
        toolName: event.toolCall.toolName,
        input: event.toolCall.input,
      },
    };
    run.tools.set(event.toolCall.toolCallId, span);
    await this.recordSpanStart(span);
  }

  private async handleToolExecutionEnd(
    event: Parameters<Callbacks["onToolExecutionEnd"]>[0],
  ): Promise<void> {
    const run = this.runs.get(event.callId);
    if (!run) return;

    // Correlate by `toolCallId` so the right span is closed even when tools
    // execute (and therefore finish) in parallel.
    const startSpan = run.tools.get(event.toolCall.toolCallId);
    if (!startSpan) return;
    run.tools.delete(event.toolCall.toolCallId);

    const isError = event.toolOutput.type === "tool-error";
    const span: Span = {
      ...startSpan,
      endTime: Date.now(),
      status: isError ? "error" : "ok",
      errorMessage: isError ? String(event.toolOutput.error) : undefined,
      tool: {
        toolName: event.toolCall.toolName,
        input: event.toolCall.input,
        output: isError ? undefined : event.toolOutput?.output,
      },
    };
    await this.recordSpanEnd(span);
  }

  private async handleStepEnd(
    event: Parameters<Callbacks["onStepEnd"]>[0],
  ): Promise<void> {
    const run = this.runs.get(event.callId);
    if (!run?.step) return;

    const startSpan = run.step;
    run.step = undefined;
    const span: Span = {
      ...startSpan,
      endTime: Date.now(),
      status: event.finishReason === "error" ? "error" : "ok",
      llm: {
        ...(startSpan.llm ?? {}),
        provider: event.model.provider,
        model: event.model.modelId,
        output: event.text,
        promptTokens: event.usage.inputTokens,
        completionTokens: event.usage.outputTokens,
        totalTokens: event.usage.totalTokens,
      },
    };
    await this.recordSpanEnd(span);
  }

  private async handleEnd(
    event: Parameters<Callbacks["onEnd"]>[0],
  ): Promise<void> {
    const run = this.runs.get(event.callId);
    if (!run) return;
    this.runs.delete(event.callId);

    if (run.step || run.tools.size > 0) {
      console.warn("[VercelAISDKTelemetry] spans left over in onEnd!");
    }

    const span: Span = {
      ...run.root,
      endTime: Date.now(),
      status: "ok",
    };
    await this.recordSpanEnd(span);
  }

  private async handleAbort(
    event: Parameters<Callbacks["onAbort"]>[0],
  ): Promise<void> {
    const run = this.runs.get(event.callId);
    if (!run) return;
    this.runs.delete(event.callId);
    await this.endOpenSpansAsError(run, String(event.reason));
  }

  /**
   * Closes a run's still-open spans (tools, then step, then root) as `error`.
   * Ending the root finalizes the trace as `error`. Used by both `onAbort` and
   * the `fail()` path so a mid-flight rejection doesn't leave spans hanging in
   * `running`.
   */
  private async endOpenSpansAsError(
    run: RunState,
    message: string,
  ): Promise<void> {
    const open = [
      ...run.tools.values(),
      ...(run.step ? [run.step] : []),
      run.root,
    ];
    for (const startSpan of open) {
      await this.recordSpanEnd({
        ...startSpan,
        endTime: Date.now(),
        status: "error",
        errorMessage: message,
      });
    }
  }

  private async handleFail(traceId: string, message: string): Promise<void> {
    // Find the in-flight run for this trace (the `fail()` caller only knows the
    // traceId). If onStart already opened spans, close them as error — which
    // also finalizes the trace. If the rejection beat onStart, there are no
    // spans yet, so just fail the trace the route pre-created.
    const entry = [...this.runs].find(([, run]) => run.traceId === traceId);
    if (entry) {
      const [callId, run] = entry;
      this.runs.delete(callId);
      await this.endOpenSpansAsError(run, message);
    } else {
      await this.failTrace(traceId, message);
    }
  }
}
