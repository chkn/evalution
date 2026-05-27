import type { Context, HrTime, SpanStatus } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span as OTelSpan,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type {
  LLMSpanDetails,
  Span,
  SpanKind,
  SpanMessage,
  Trace,
  TraceChangeEvent,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from '../shared/types.ts';
import { SPAN_KIND_ATTRIBUTE, type TraceProvider } from './trace-provider.ts';
import { otelOperationToSpanKind } from '../shared/helpers.ts';

const KNOWN_KINDS: readonly SpanKind[] = [
  'LLM',
  'TOOL',
  'AGENT',
  'EMBEDDING',
  'DEFAULT'
];

function hrTimeToMs(time: HrTime): number {
  return time[0] * 1000 + time[1] / 1e6;
}

function readKind(attributes: Record<string, unknown>): SpanKind {
  const raw = (attributes[SPAN_KIND_ATTRIBUTE] as SpanKind | undefined) ?? otelOperationToSpanKind(attributes['gen_ai.operation.name']);
  return typeof raw === 'string' && KNOWN_KINDS.includes(raw) ? raw : 'DEFAULT';
}

const PARAM_ATTRIBUTES = [
  'gen_ai.request.temperature',
  'gen_ai.request.max_tokens',
  'gen_ai.request.top_k',
  'gen_ai.request.top_p',
  'gen_ai.request.frequency_penalty',
  'gen_ai.request.presence_penalty',
  'gen_ai.request.seed',
  'gen_ai.request.stop_sequences',
  'gen_ai.request.choice.count',
] as const;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function parseMessages(v: unknown): SpanMessage[] | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return [];
      const m = msg as Record<string, unknown>;
      const role = str(m['role']) ?? 'unknown';
      const content = m['content'];
      if (typeof content === 'string') return [{ role, content }];
      if (Array.isArray(content)) {
        const text = content
          .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
          .filter((c) => c['type'] === 'text')
          .map((c) => str(c['text']) ?? '')
          .join('');
        return text ? [{ role, content: text }] : [];
      }
      return [];
    });
  } catch {
    return undefined;
  }
}

function parseOutput(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .flatMap((msg: unknown) => {
        if (!msg || typeof msg !== 'object') return [];
        const m = msg as Record<string, unknown>;
        const content = m['content'];
        if (typeof content === 'string') return [content];
        if (Array.isArray(content)) {
          return content
            .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
            .filter((c) => c['type'] === 'text')
            .map((c) => str(c['text']) ?? '');
        }
        return [];
      })
      .join('\n');
  } catch {
    return undefined;
  }
}

function readLLM(attributes: Record<string, unknown>): LLMSpanDetails | undefined {
  const provider = str(attributes['gen_ai.provider.name']) ?? str(attributes['gen_ai.system']);
  const model = str(attributes['gen_ai.response.model']) ?? str(attributes['gen_ai.request.model']);
  const promptTokens = num(attributes['gen_ai.usage.input_tokens']);
  const completionTokens = num(attributes['gen_ai.usage.output_tokens']);
  const messages = parseMessages(attributes['gen_ai.input.messages']);
  const output = parseOutput(attributes['gen_ai.output.messages']);

  const paramEntries = PARAM_ATTRIBUTES
    .map((key) => [key.replace('gen_ai.request.', ''), attributes[key]] as const)
    .filter(([, v]) => v !== undefined);
  const parameters = paramEntries.length > 0 ? Object.fromEntries(paramEntries) : undefined;

  const totalTokens =
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined;

  if (!provider && !model && !promptTokens && !completionTokens && !messages && !output && !parameters) {
    return undefined;
  }

  return {
    ...(provider && { provider }),
    ...(model && { model }),
    ...(messages && { messages }),
    ...(output && { output }),
    ...(promptTokens !== undefined && { promptTokens }),
    ...(completionTokens !== undefined && { completionTokens }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(parameters && { parameters }),
  };
}

function llmAndPrompt(attributes: Record<string, unknown>): Partial<Span> {
  const llm = readLLM(attributes);
  const promptProviderId = str(attributes['evalution.prompt.provider.id']);
  const promptId = str(attributes['evalution.prompt.id']);
  return {
    ...(llm && { llm }),
    ...(promptProviderId && { promptProviderId }),
    ...(promptId && { promptId }),
  };
}

function mapStatus(status: SpanStatus): 'ok' | 'error' | undefined {
  if (status.code === SpanStatusCode.ERROR) return 'error';
  if (status.code === SpanStatusCode.OK) return 'ok';
  return undefined;
}

/**
 * Base class for a {@link TraceProvider} populated by OpenTelemetry spans.
 *
 * Register the processor returned by {@link getSpanProcessor} on a
 * `BasicTracerProvider` (from `@opentelemetry/sdk-trace-base`).
 */
export abstract class BaseOTelTraceProvider implements TraceProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;

  private subscribers = new Map<string, Set<(event: TraceStreamEvent) => void>>();
  private watchers = new Set<(event: TraceChangeEvent) => void>();
  private spanPromises = new Map<string, Promise<void>>();

  constructor(options: { id: string; displayName: string; description: string }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.description = options.description;
  }

  abstract getAllTraces(): Promise<TraceSummary[]>;

  abstract hasTrace(traceId: string): Promise<boolean>;

  protected abstract getTraceWithoutSpans(traceId: string): Promise<Trace | undefined>;

  protected abstract getTraceSpans(traceId: string): Promise<Span[]>;

  protected abstract addOrUpdateTrace(trace: Trace): Promise<void>;

  protected abstract addOrUpdateSpan(span: Span): Promise<void>;

  async getTrace(traceId: string): Promise<TraceWithSpans | undefined> {
    const trace = await this.getTraceWithoutSpans(traceId);
    if (!trace) return undefined;
    const spans = await this.getTraceSpans(traceId);
    return { trace, spans };
  }

  subscribeTrace(traceId: string, callback: (event: TraceStreamEvent) => void): () => void {
    let set = this.subscribers.get(traceId);
    if (!set) {
      set = new Set();
      this.subscribers.set(traceId, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) this.subscribers.delete(traceId);
    };
  }

  watch(callback: (event: TraceChangeEvent) => void): () => void {
    this.watchers.add(callback);
    return () => {
      this.watchers.delete(callback);
    };
  }

  /**
   * Returns a `SpanProcessor` that funnels every OpenTelemetry span the
   * caller's tracer produces into this provider's in-memory store.
   */
  getSpanProcessor(): SpanProcessor {
    return {
      onStart: (span: OTelSpan, _parentContext: Context) => {
        const spanId = span.spanContext().spanId;
        const p = this.handleStart(span).catch(console.error);
        this.spanPromises.set(spanId, p);
        p.finally(() => this.spanPromises.delete(spanId));
      },
      onEnd: (span: ReadableSpan) => {
        const spanId = span.spanContext().spanId;
        const startP = this.spanPromises.get(spanId) ?? Promise.resolve();
        const p = startP.then(() => this.handleEnd(span)).catch(console.error);
        this.spanPromises.set(spanId, p);
        p.finally(() => this.spanPromises.delete(spanId));
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
  }

  private async handleStart(span: OTelSpan): Promise<void> {
    const ctx = span.spanContext();
    const traceId = ctx.traceId;
    const spanId = ctx.spanId;
    const parentCtx = span.parentSpanContext;
    const isRoot = !parentCtx || parentCtx.traceId !== traceId;

    if (isRoot && !(await this.hasTrace(traceId))) {
      const startTime = hrTimeToMs(span.startTime);
      const trace: Trace = {
        id: traceId,
        providerId: this.id,
        name: span.name,
        startTime,
        status: 'running',
        attributes: { ...span.attributes },
      };
      await this.addOrUpdateTrace(trace);
      this.emitChange({ type: 'add', traceId });
    }

    const ourSpan: Span = {
      id: spanId,
      traceId,
      parentId: parentCtx && parentCtx.traceId === traceId ? parentCtx.spanId : undefined,
      name: span.name,
      kind: readKind(span.attributes),
      startTime: hrTimeToMs(span.startTime),
      attributes: { ...span.attributes },
      ...llmAndPrompt(span.attributes),
    };
    await this.addOrUpdateSpan(ourSpan);
    this.emitStream(traceId, { type: 'span-start', span: ourSpan });
  }

  private async handleEnd(span: ReadableSpan): Promise<void> {
    const ctx = span.spanContext();
    const traceId = ctx.traceId;
    const spanId = ctx.spanId;

    const ended: Span = {
      id: spanId,
      traceId,
      parentId:
        span.parentSpanContext && span.parentSpanContext.traceId === traceId
          ? span.parentSpanContext.spanId
          : undefined,
      name: span.name,
      kind: readKind(span.attributes),
      startTime: hrTimeToMs(span.startTime),
      endTime: hrTimeToMs(span.endTime),
      status: mapStatus(span.status),
      errorMessage: span.status.code === SpanStatusCode.ERROR ? span.status.message : undefined,
      attributes: { ...span.attributes },
      ...llmAndPrompt(span.attributes),
    };
    await this.addOrUpdateSpan(ended);
    this.emitStream(traceId, { type: 'span-end', span: ended });

    // If span is root span, update trace as well
    if (!ended.parentId) {
      const existing = await this.getTraceWithoutSpans(traceId);
      if (existing) {
        const endedTrace: Trace = {
          ...existing,
          endTime: ended.endTime,
          status: ended.status === 'error' ? 'error' : 'ok',
        };
        await this.addOrUpdateTrace(endedTrace);
        this.emitStream(traceId, { type: 'trace-end', trace: endedTrace });
        this.emitChange({ type: 'update', traceId });
      }
    }
  }

  private emitStream(traceId: string, event: TraceStreamEvent): void {
    const set = this.subscribers.get(traceId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(event);
      } catch (err) {
        console.error('Trace subscriber threw:', err);
      }
    }
  }

  private emitChange(event: TraceChangeEvent): void {
    for (const cb of this.watchers) {
      try {
        cb(event);
      } catch (err) {
        console.error('Trace watcher threw:', err);
      }
    }
  }

  async drainPendingHandlers(): Promise<void> {
    while (this.spanPromises.size > 0) {
      await Promise.all([...this.spanPromises.values()]);
    }
  }
}
