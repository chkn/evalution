import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DummyTraceProvider } from './dummy-trace-provider.ts';
import type { TraceStreamEvent } from '../shared/types.ts';

describe('DummyTraceProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns a unique trace ID and exposes the trace via getTrace', async () => {
    const provider = new DummyTraceProvider();
    const trace = await provider.beginPromptTrace({
      promptProviderId: 'p',
      promptId: 'hello',
      promptName: 'hello',
      functionParams: [],
    });

    expect(trace.id).toMatch(/^dummy-/);
    const loaded = await provider.getTrace(trace.id);
    expect(loaded?.trace.id).toBe(trace.id);
    expect(loaded?.spans).toHaveLength(0);
  });

  it('streams span-start then span-end events as simulated time advances', async () => {
    const provider = new DummyTraceProvider();
    const trace = await provider.beginPromptTrace({
      promptProviderId: 'p',
      promptId: 'hello',
      promptName: 'workflow',
      functionParams: [],
    });

    const events: TraceStreamEvent[] = [];
    provider.subscribeTrace(trace.id, (e) => events.push(e));

    // Advance enough for the whole simulated waterfall to finish.
    await vi.advanceTimersByTimeAsync(5000);

    const starts = events.filter((e) => e.type === 'span-start');
    const ends = events.filter((e) => e.type === 'span-end');
    const traceEnds = events.filter((e) => e.type === 'trace-end');

    expect(starts.length).toBeGreaterThan(0);
    expect(starts.length).toBe(ends.length);
    expect(traceEnds).toHaveLength(1);

    const loaded = await provider.getTrace(trace.id);
    expect(loaded?.trace.status).toBe('ok');
    expect(loaded?.spans.every((s) => s.endTime !== undefined)).toBe(true);
  });

  it('getAllTraces lists newly-created traces, newest first', async () => {
    const provider = new DummyTraceProvider();
    const a = await provider.beginPromptTrace({
      promptProviderId: 'p', promptId: 'a', promptName: 'a', functionParams: [],
    });
    vi.setSystemTime(new Date(Date.now() + 1000));
    const b = await provider.beginPromptTrace({
      promptProviderId: 'p', promptId: 'b', promptName: 'b', functionParams: [],
    });

    const summaries = await provider.getAllTraces();
    expect(summaries.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('notifies watchers when traces are added and updated', async () => {
    const provider = new DummyTraceProvider();
    const seen: string[] = [];
    provider.watch((e) => seen.push(`${e.type}:${e.traceId}`));

    const trace = await provider.beginPromptTrace({
      promptProviderId: 'p', promptId: 'x', promptName: 'x', functionParams: [],
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(seen).toContain(`add:${trace.id}`);
    expect(seen).toContain(`update:${trace.id}`);
  });
});
