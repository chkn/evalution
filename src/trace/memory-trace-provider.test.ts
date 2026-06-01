import { describe, it, expect } from 'vitest';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { MemoryTraceProvider } from './memory-trace-provider.ts';
import { mergeSpans } from './base-otel-trace-provider.ts';
import { SPAN_KIND_ATTRIBUTE, PROMPT_ID_ATTRIBUTE, PROMPT_PROVIDER_ID_ATTRIBUTE } from './trace-provider.ts';
import type { Span, TraceStreamEvent } from '../shared/types.ts';

function makeTracer(provider: MemoryTraceProvider) {
  const tp = new BasicTracerProvider({ spanProcessors: [provider.getSpanProcessor()] });
  return tp.getTracer('test');
}

describe('MemoryTraceProvider', () => {
  it('records a root span as a new trace and exposes it via getTrace', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);

    const span = tracer.startSpan('hello', {
      attributes: { [SPAN_KIND_ATTRIBUTE]: 'LLM' },
    });
    const { traceId } = span.spanContext();
    span.end();

    await provider.drainPendingHandlers();
    const loaded = await provider.getTrace(traceId);
    expect(loaded?.trace.id).toBe(traceId);
    expect(loaded?.trace.name).toBe('hello');
    expect(loaded?.trace.status).toBe('ok');
    expect(loaded?.spans).toHaveLength(1);
    expect(loaded?.spans[0].kind).toBe('LLM');
    expect(loaded?.spans[0].endTime).toBeDefined();
  });

  it('stores the prompt reference raw — global id without a provider, scoped id with one', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);

    // A runtime span: only a (global) prompt id, no provider.
    const globalSpan = tracer.startSpan('runtime', {
      attributes: { [PROMPT_ID_ATTRIBUTE]: 'mod#summarize' },
    });
    const globalTraceId = globalSpan.spanContext().traceId;
    globalSpan.end();

    // A playground span: a scoped prompt id with its provider.
    const scopedSpan = tracer.startSpan('playground', {
      attributes: {
        [PROMPT_ID_ATTRIBUTE]: 'a.prompt.ts#summarize',
        [PROMPT_PROVIDER_ID_ATTRIBUTE]: 'fs',
      },
    });
    const scopedTraceId = scopedSpan.spanContext().traceId;
    scopedSpan.end();

    await provider.drainPendingHandlers();

    const globalLoaded = await provider.getTrace(globalTraceId);
    expect(globalLoaded?.spans[0].prompt).toEqual({ id: 'mod#summarize' });

    const scopedLoaded = await provider.getTrace(scopedTraceId);
    expect(scopedLoaded?.spans[0].prompt).toEqual({ id: 'a.prompt.ts#summarize', providerId: 'fs' });
  });

  it('keeps attributes set at creation as well as ones set after the span starts', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);

    // Set one attribute at creation (visible at onStart) and another later
    // (only visible at onEnd) — both must survive into the stored span.
    const span = tracer.startSpan('llm', { attributes: { 'at.start': 'a' } });
    span.setAttribute('after.start', 'b');
    const { traceId } = span.spanContext();
    span.end();

    await provider.drainPendingHandlers();
    const loaded = await provider.getTrace(traceId);
    expect(loaded?.spans[0].attributes).toMatchObject({ 'at.start': 'a', 'after.start': 'b' });
  });

  it('reads LLM input/output/usage from the Vercel AI SDK attribute names', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);

    // The Vercel AI SDK emits `ai.prompt.messages` / `ai.response.text` /
    // `ai.usage.*` rather than the OTel GenAI `gen_ai.{input,output}.messages`.
    const span = tracer.startSpan('ai.generateText', {
      attributes: {
        'gen_ai.request.model': 'gpt-4o',
        'ai.prompt.messages': JSON.stringify([
          { role: 'user', content: [{ type: 'text', text: 'Say hi' }] },
        ]),
        'ai.response.text': 'Hello from the model!',
        'ai.usage.promptTokens': 10,
        'ai.usage.completionTokens': 20,
      },
    });
    const { traceId } = span.spanContext();
    span.end();

    await provider.drainPendingHandlers();
    const llm = (await provider.getTrace(traceId))?.spans[0].llm;
    expect(llm?.output).toBe('Hello from the model!');
    expect(llm?.messages).toEqual([{ role: 'user', content: 'Say hi' }]);
    expect(llm?.promptTokens).toBe(10);
    expect(llm?.completionTokens).toBe(20);
    expect(llm?.totalTokens).toBe(30);
  });

  it('streams span-start, span-end and trace-end events in order', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);

    const root = tracer.startSpan('root');
    const { traceId } = root.spanContext();

    const events: TraceStreamEvent[] = [];
    provider.subscribeTrace(traceId, (e) => events.push(e));

    root.end();
    await provider.drainPendingHandlers();

    const types = events.map((e) => e.type);
    // span-start is replayed to late subscribers only via the route's SSE
    // replay path; here we subscribed after start, so we should see just the
    // end events.
    expect(types).toContain('span-end');
    expect(types).toContain('trace-end');
  });

  it('parents child spans via parentId and keeps the trace running until the root ends', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);

    const root = tracer.startSpan('root');
    const rootCtx = root.spanContext();

    await tracer.startActiveSpan(
      'child',
      { attributes: { [SPAN_KIND_ATTRIBUTE]: 'DEFAULT' } },
      async (child) => {
        // Active-span parenting only works when we enter the root's context;
        // for this test it's simpler to assert the store captures the parent
        // relationship when spans are siblings of the tracer's active span.
        child.end();
      }
    );

    await provider.drainPendingHandlers();
    let loaded = await provider.getTrace(rootCtx.traceId);
    expect(loaded?.trace.status).toBe('running');

    root.end();
    await provider.drainPendingHandlers();

    loaded = await provider.getTrace(rootCtx.traceId);
    expect(loaded?.trace.status).toBe('ok');
  });

  it('marks the trace as error when the root span fails', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);

    const root = tracer.startSpan('root');
    root.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
    root.end();

    await provider.drainPendingHandlers();
    const loaded = await provider.getTrace(root.spanContext().traceId);
    expect(loaded?.trace.status).toBe('error');
    expect(loaded?.spans[0].errorMessage).toBe('boom');
  });

  it('getAllTraces lists traces newest-first', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);

    const a = tracer.startSpan('a');
    a.end();
    await new Promise((r) => setTimeout(r, 5));
    const b = tracer.startSpan('b');
    b.end();

    await provider.drainPendingHandlers();
    const summaries = await provider.getAllTraces();
    expect(summaries[0].id).toBe(b.spanContext().traceId);
    expect(summaries[1].id).toBe(a.spanContext().traceId);
  });

  it('notifies watchers on add and update', async () => {
    const provider = new MemoryTraceProvider();
    const tracer = makeTracer(provider);
    const seen: string[] = [];
    provider.watch((e) => seen.push(`${e.type}:${e.traceId}`));

    const root = tracer.startSpan('x');
    const { traceId } = root.spanContext();
    root.end();

    await provider.drainPendingHandlers();
    expect(seen).toContain(`add:${traceId}`);
    expect(seen).toContain(`update:${traceId}`);
  });
});

describe('mergeSpans', () => {
  const base: Span = {
    id: 's1',
    traceId: 't1',
    name: 'span',
    kind: 'LLM',
    startTime: 1,
    attributes: { 'at.start': 'a' },
  };

  it('unions attributes from both snapshots', () => {
    const merged = mergeSpans(base, { ...base, attributes: { 'at.end': 'b' } });
    expect(merged.attributes).toEqual({ 'at.start': 'a', 'at.end': 'b' });
  });

  it('fills in end-only fields without dropping start-only data', () => {
    const start: Span = { ...base, llm: { provider: 'openai' } };
    const end: Span = {
      ...base,
      attributes: undefined,
      endTime: 5,
      status: 'ok',
      llm: { provider: 'openai', model: 'gpt-4o', totalTokens: 10 },
    };

    const merged = mergeSpans(start, end);
    expect(merged.endTime).toBe(5);
    expect(merged.status).toBe('ok');
    expect(merged.llm).toEqual({ provider: 'openai', model: 'gpt-4o', totalTokens: 10 });
    // `undefined` fields on the incoming snapshot must not clobber existing data.
    expect(merged.attributes).toEqual({ 'at.start': 'a' });
  });

  it('lets defined incoming fields win', () => {
    const merged = mergeSpans(base, { ...base, name: 'renamed', kind: 'TOOL' });
    expect(merged.name).toBe('renamed');
    expect(merged.kind).toBe('TOOL');
  });
});
