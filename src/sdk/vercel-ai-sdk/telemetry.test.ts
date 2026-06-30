// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it } from "vitest";
import { MemoryTraceProvider } from "../../trace/memory-trace-provider.ts";
import { VercelAISDKTelemetry } from "./telemetry.ts";

afterEach(() => {
  delete (globalThis as any).AI_SDK_TELEMETRY_INTEGRATIONS;
});

function startEvent(callId: string) {
  return {
    callId,
    operationId: "ai.generateText",
    provider: "openai",
    modelId: "gpt-4o",
    tools: undefined,
    toolChoice: undefined,
    activeTools: [],
    toolOrder: [],
    maxRetries: 1,
    timeout: undefined,
    headers: undefined,
    providerOptions: undefined,
    output: undefined,
    toolsContext: {},
    runtimeContext: {},
    instructions: undefined,
    messages: [],
  } satisfies Parameters<VercelAISDKTelemetry["onStart"]>[0];
}

function stepEndEvent(callId: string, text: string) {
  return {
    callId,
    stepNumber: 0,
    model: { provider: "openai", modelId: "gpt-4o" },
    text,
    usage: {
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      inputTokenDetails: {} as any,
      outputTokenDetails: {} as any,
    },
  } as any;
}

describe("Evalution", () => {
  it("createTelemetryForPrompt records a single-step generation with full prompt identity", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });

    const traceId = "trace-1";
    const integration = evalution
      .createTelemetryForPrompt({
        id: "mod#greet",
        name: "greet",
        functionParameters: ["Ada"],
      })
      .withTraceId(traceId);

    const callId = "call-1";

    await integration.onStart?.(startEvent(callId));
    await integration.onStepStart?.({
      ...startEvent(callId),
      stepNumber: 0,
      steps: [],
      messages: [{ role: "user", content: "Hi Ada" }],
    } as any);
    await integration.onStepEnd?.(stepEndEvent(callId, "Hello!"));
    await integration.onEnd?.({ callId, text: "Hello!" } as any);

    const trace = await provider.getTrace(traceId);
    expect(trace?.trace.status).toBe("ok");
    expect(trace?.spans).toHaveLength(2); // root + step
    const root = trace?.spans.find(s => !s.parentId);
    expect(root?.prompt?.id).toBe("mod#greet");
    expect(root?.prompt?.functionParameters).toEqual(["Ada"]);
    const step = trace?.spans.find(s => s.parentId);
    expect(step?.llm?.messages).toEqual([{ role: "user", content: "Hi Ada" }]);
    expect(step?.llm?.totalTokens).toBe(8);
  });

  it("records a tool call nested under the current step", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });
    const traceId = "trace-tool";
    const integration = evalution
      .createTelemetryForPrompt({ id: "mod#agent", name: "agent" })
      .withTraceId(traceId);
    const callId = "call-tool";

    await integration.onStart?.(startEvent(callId));
    await integration.onStepStart?.({
      ...startEvent(callId),
      stepNumber: 0,
      steps: [],
      messages: [],
    } as any);
    await integration.onToolExecutionStart?.({
      callId,
      toolCall: { toolCallId: "t1", toolName: "search", input: { q: "x" } },
      messages: [],
      toolContext: {},
    } as any);
    await integration.onToolExecutionEnd?.({
      callId,
      toolCall: { toolCallId: "t1", toolName: "search", input: { q: "x" } },
      toolOutput: { type: "tool-result", output: { hits: 1 } },
      toolExecutionMs: 12,
      messages: [],
      toolContext: {},
    } as any);

    const trace = await provider.getTrace(traceId);
    const tool = trace?.spans.find(s => s.kind === "TOOL");
    expect(tool?.status).toBe("ok");
    expect(tool?.name).toContain("search");
    const root = trace?.spans.find(s => !s.parentId);
    expect(root?.kind).toBe("AGENT");
  });

  it("correlates parallel tool calls by toolCallId", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });
    const traceId = "trace-parallel-tools";
    const integration = evalution
      .createTelemetryForPrompt({ id: "mod#agent", name: "agent" })
      .withTraceId(traceId);
    const callId = "call-parallel";

    const alpha = { toolCallId: "ta", toolName: "alpha", input: { n: 1 } };
    const beta = { toolCallId: "tb", toolName: "beta", input: { n: 2 } };

    await integration.onStart?.(startEvent(callId));
    await integration.onStepStart?.({
      ...startEvent(callId),
      stepNumber: 0,
      steps: [],
      messages: [],
    } as any);

    // Two tools run concurrently: both starts arrive before either end.
    await integration.onToolExecutionStart?.({
      callId,
      toolCall: alpha,
      messages: [],
      toolContext: {},
    } as any);
    await integration.onToolExecutionStart?.({
      callId,
      toolCall: beta,
      messages: [],
      toolContext: {},
    } as any);
    await integration.onToolExecutionEnd?.({
      callId,
      toolCall: alpha,
      toolOutput: { type: "tool-result", output: { r: "A" } },
      messages: [],
      toolContext: {},
    } as any);
    await integration.onToolExecutionEnd?.({
      callId,
      toolCall: beta,
      toolOutput: { type: "tool-result", output: { r: "B" } },
      messages: [],
      toolContext: {},
    } as any);

    const trace = await provider.getTrace(traceId);
    const step = trace?.spans.find(s => s.kind === "LLM");
    const tools = trace?.spans.filter(s => s.kind === "TOOL") ?? [];
    expect(tools).toHaveLength(2);

    // Every tool span is parented to the step, never to a sibling tool.
    for (const t of tools) expect(t.parentId).toBe(step?.id);

    // Each tool span carries its own output, not a sibling's.
    const alphaSpan = tools.find(t => t.name.includes("alpha"));
    const betaSpan = tools.find(t => t.name.includes("beta"));
    expect(alphaSpan?.tool?.output).toEqual({ r: "A" });
    expect(betaSpan?.tool?.output).toEqual({ r: "B" });
  });

  it("marks a step span as error when its finishReason is error", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });
    const traceId = "trace-step-err";
    const integration = evalution
      .createTelemetryForPrompt({ id: "mod#x", name: "x" })
      .withTraceId(traceId);
    const callId = "call-step-err";

    await integration.onStart?.(startEvent(callId));
    await integration.onStepStart?.({
      ...startEvent(callId),
      stepNumber: 0,
      steps: [],
      messages: [],
    } as any);
    await integration.onStepEnd?.({
      ...stepEndEvent(callId, ""),
      finishReason: "error",
    });

    const trace = await provider.getTrace(traceId);
    const step = trace?.spans.find(s => s.kind === "LLM");
    expect(step?.status).toBe("error");
  });

  it("fail() ends still-open child spans as error, not just the trace", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });
    const traceId = "trace-fail-leak";
    const integration = evalution
      .createTelemetryForPrompt({ id: "mod#x", name: "x" })
      .withTraceId(traceId);
    const callId = "call-fail-leak";

    await integration.onStart?.(startEvent(callId));
    await integration.onStepStart?.({
      ...startEvent(callId),
      stepNumber: 0,
      steps: [],
      messages: [],
    } as any);

    // generateText rejects mid-flight (after a step opened): fail() must end the
    // dangling step span, not leave it hanging in `running`.
    await integration.fail("boom");

    const trace = await provider.getTrace(traceId);
    expect(trace?.trace.status).toBe("error");
    const step = trace?.spans.find(s => s.kind === "LLM");
    expect(step?.status).toBe("error");
    expect(step?.endTime).toBeDefined();
  });

  it("marks a tool span as error when toolOutput.type is tool-error", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });
    const traceId = "trace-tool-err";
    const integration = evalution
      .createTelemetryForPrompt({ id: "mod#agent", name: "agent" })
      .withTraceId(traceId);
    const callId = "call-tool-err";

    await integration.onStart?.(startEvent(callId));
    await integration.onStepStart?.({
      ...startEvent(callId),
      stepNumber: 0,
      steps: [],
      messages: [],
    } as any);
    await integration.onToolExecutionStart?.({
      callId,
      toolCall: { toolCallId: "t1", toolName: "search", input: {} },
      messages: [],
      toolContext: {},
    } as any);
    await integration.onToolExecutionEnd?.({
      callId,
      toolCall: { toolCallId: "t1", toolName: "search", input: {} },
      toolOutput: { type: "tool-error", error: new Error("boom") },
      messages: [],
      toolContext: {},
    } as any);

    const trace = await provider.getTrace(traceId);
    const tool = trace?.spans.find(s => s.kind === "TOOL");
    expect(tool?.status).toBe("error");
  });

  it("root onStart lazily creates the running trace and emits span-start", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });
    const traceId = "trace-pre";
    const integration = evalution
      .createTelemetryForPrompt({ id: "mod#x", name: "x" })
      .withTraceId(traceId);

    // No pre-creation: the trace does not exist until the root span starts.
    expect(await provider.hasTrace(traceId)).toBe(false);

    const events: string[] = [];
    provider.subscribeTrace(traceId, e => events.push(e.type));

    await integration.onStart?.(startEvent("call-pre"));

    expect(events).toContain("span-start");
    expect((await provider.getTrace(traceId))?.trace.name).toBe("x");
    expect((await provider.getTrace(traceId))?.trace.status).toBe("running");
  });

  it("abort finishes the trace as error", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });
    const traceId = "trace-abort";
    const integration = evalution
      .createTelemetryForPrompt({ id: "mod#x", name: "x" })
      .withTraceId(traceId);
    const callId = "call-abort";

    await integration.onStart?.(startEvent(callId));
    await integration.onAbort?.({
      callId,
      steps: [],
      reason: "aborted",
    } as any);

    const trace = await provider.getTrace(traceId);
    expect(trace?.trace.status).toBe("error");
  });

  it("two concurrent createTelemetryForPrompt integrations stay in separate traces", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });
    const traceIdA = "trace-concurrent-a";
    const traceIdB = "trace-concurrent-b";
    const a = evalution
      .createTelemetryForPrompt({ id: "mod#a", name: "a" })
      .withTraceId(traceIdA);
    const b = evalution
      .createTelemetryForPrompt({ id: "mod#b", name: "b" })
      .withTraceId(traceIdB);

    expect(traceIdA).not.toBe(traceIdB);

    await Promise.all([
      a.onStart?.(startEvent("call-a")),
      b.onStart?.(startEvent("call-b")),
    ]);
    await Promise.all([
      a.onEnd?.({ callId: "call-a" } as any),
      b.onEnd?.({ callId: "call-b" } as any),
    ]);

    const traceA = await provider.getTrace(traceIdA);
    const traceB = await provider.getTrace(traceIdB);
    expect(traceA?.trace.status).toBe("ok");
    expect(traceB?.trace.status).toBe("ok");
    expect(traceA?.spans.length).toBeGreaterThan(0);
    expect(traceB?.spans.length).toBeGreaterThan(0);
  });

  it("fans out to every added sink and stops after removeSink", async () => {
    const evalution = new VercelAISDKTelemetry();
    const sinkA = new MemoryTraceProvider({ id: "a" });
    const sinkB = new MemoryTraceProvider({ id: "b" });
    evalution.addSink(sinkA);
    evalution.addSink(sinkB);

    const traceId1 = "trace-fanout-1";
    const integration = evalution
      .createTelemetryForPrompt({ id: "mod#x", name: "x" })
      .withTraceId(traceId1);
    await integration.onStart?.(startEvent("call-fanout"));

    expect(await sinkA.hasTrace(traceId1)).toBe(true);
    expect(await sinkB.hasTrace(traceId1)).toBe(true);

    expect(evalution.removeSink(sinkB)).toBe(true);
    const traceId2 = "trace-fanout-2";
    const integration2 = evalution
      .createTelemetryForPrompt({ id: "mod#y", name: "y" })
      .withTraceId(traceId2);
    await integration2.onStart?.(startEvent("call-fanout-2"));

    expect(await sinkA.hasTrace(traceId2)).toBe(true);
    expect(await sinkB.hasTrace(traceId2)).toBe(false);
  });

  it('global fallback onStart is a no-op when nativeTelemetry is "never"', async () => {
    const evalution = new VercelAISDKTelemetry({ nativeTelemetry: "never" });
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });

    await evalution.onStart(startEvent("call-never"));

    expect(await provider.getAllTraces()).toHaveLength(0);
  });

  it('global fallback onStart defers ("auto") when a sibling OpenTelemetry integration is registered', async () => {
    class OpenTelemetry {}
    (globalThis as any).AI_SDK_TELEMETRY_INTEGRATIONS = [new OpenTelemetry()];

    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });

    await evalution.onStart(startEvent("call-auto-defer"));

    expect(await provider.getAllTraces()).toHaveLength(0);
  });

  it("global fallback records without prompt identity when not deferring", async () => {
    const evalution = new VercelAISDKTelemetry();
    const provider = new MemoryTraceProvider({ ingestors: [evalution] });

    await evalution.onStart(startEvent("call-fallback"));
    await evalution.onEnd({ callId: "call-fallback" } as any);

    const traces = await provider.getAllTraces();
    expect(traces).toHaveLength(1);
    const trace = await provider.getTrace(traces[0].id);
    expect(trace?.spans[0].prompt).toBeUndefined();
  });
});
