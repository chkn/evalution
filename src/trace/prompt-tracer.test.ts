// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, it, expect, vi } from 'vitest';
import { trace, type Span, type SpanOptions, type Tracer } from '@opentelemetry/api';
import {
  createTracerForPrompt,
  PROMPT_ID_ATTRIBUTE,
  PROMPT_NAME_ATTRIBUTE,
  SPAN_KIND_ATTRIBUTE,
} from './prompt-tracer.ts';

/** Minimal fake span that records nothing — we only assert on tracer calls. */
const fakeSpan = {} as Span;

interface RecordingTracer extends Tracer {
  startSpanCalls: { name: string; options?: SpanOptions }[];
  activeSpanCalls: { name: string; options?: SpanOptions }[];
}

function recordingTracer(): RecordingTracer {
  const startSpanCalls: RecordingTracer['startSpanCalls'] = [];
  const activeSpanCalls: RecordingTracer['activeSpanCalls'] = [];
  return {
    startSpanCalls,
    activeSpanCalls,
    startSpan(name: string, options?: SpanOptions) {
      startSpanCalls.push({ name, options });
      return fakeSpan;
    },
    startActiveSpan(name: string, ...rest: any[]): any {
      const fn = rest[rest.length - 1];
      const options = typeof rest[0] === 'function' ? undefined : rest[0];
      activeSpanCalls.push({ name, options });
      return fn(fakeSpan);
    },
  };
}

describe('createTracerForPrompt', () => {
  it('attaches the prompt name and LLM span kind to startSpan spans', () => {
    const inner = recordingTracer();
    createTracerForPrompt({ name: 'My Prompt' }, inner).startSpan('child');

    expect(inner.startSpanCalls[0].options?.attributes).toEqual({
      [SPAN_KIND_ATTRIBUTE]: 'LLM',
      [PROMPT_NAME_ATTRIBUTE]: 'My Prompt',
    });
    // No global id given ⇒ the prompt-id attribute is omitted.
    expect(inner.startSpanCalls[0].options?.attributes).not.toHaveProperty(PROMPT_ID_ATTRIBUTE);
  });

  it('attaches the global prompt id when one is provided', () => {
    const inner = recordingTracer();
    createTracerForPrompt({ name: 'My Prompt', id: 'mod#myPrompt' }, inner).startSpan('child');

    expect(inner.startSpanCalls[0].options?.attributes).toEqual({
      [SPAN_KIND_ATTRIBUTE]: 'LLM',
      [PROMPT_NAME_ATTRIBUTE]: 'My Prompt',
      [PROMPT_ID_ATTRIBUTE]: 'mod#myPrompt',
    });
  });

  it('lets per-span attributes override the prompt defaults', () => {
    const inner = recordingTracer();
    createTracerForPrompt({ name: 'My Prompt' }, inner).startSpan('child', {
      attributes: { [SPAN_KIND_ATTRIBUTE]: 'TOOL', extra: 'kept' },
    });

    expect(inner.startSpanCalls[0].options?.attributes).toEqual({
      [SPAN_KIND_ATTRIBUTE]: 'TOOL',
      [PROMPT_NAME_ATTRIBUTE]: 'My Prompt',
      extra: 'kept',
    });
  });

  it('attaches attributes and forwards the callback result for startActiveSpan', () => {
    const inner = recordingTracer();
    const result = createTracerForPrompt({ name: 'My Prompt' }, inner).startActiveSpan(
      'child',
      span => {
        expect(span).toBe(fakeSpan);
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(inner.activeSpanCalls[0].options?.attributes).toEqual({
      [SPAN_KIND_ATTRIBUTE]: 'LLM',
      [PROMPT_NAME_ATTRIBUTE]: 'My Prompt',
    });
  });

  it('merges attributes into the startActiveSpan options overload', () => {
    const inner = recordingTracer();
    createTracerForPrompt({ name: 'My Prompt' }, inner).startActiveSpan(
      'child',
      { attributes: { extra: 'kept' } },
      () => undefined,
    );

    expect(inner.activeSpanCalls[0].options?.attributes).toEqual({
      [SPAN_KIND_ATTRIBUTE]: 'LLM',
      [PROMPT_NAME_ATTRIBUTE]: 'My Prompt',
      extra: 'kept',
    });
  });

  it('falls back to a tracer from the global provider when none is given', () => {
    const getTracer = vi.spyOn(trace, 'getTracer');
    createTracerForPrompt({ name: 'My Prompt' });
    expect(getTracer).toHaveBeenCalledWith('evalution');
    getTracer.mockRestore();
  });
});
