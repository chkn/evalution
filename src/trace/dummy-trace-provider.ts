import type {
  BeginPromptTraceInfo,
  Span,
  SpanKind,
  Trace,
  TraceChangeEvent,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from '../shared/types.ts';
import type { TraceProvider } from './trace-provider.ts';

/** Plan entry describing a synthetic span to emit during simulation. */
interface SpanPlan {
  name: string;
  kind: SpanKind;
  /** Offset from trace start (ms) at which the span begins. */
  startOffset: number;
  /** Duration of the span (ms). */
  duration: number;
  /** Index of the parent span in the plan, or `undefined` for the root. */
  parentIndex?: number;
  llm?: Span['llm'];
  attributes?: Span['attributes'];
}

/**
 * Builds a plan that mirrors the screenshot: a workflow coordinating
 * joke creation, translation, and a signature step — each backed by LLM
 * chat/completion spans and one tool call.
 */
function buildPlan(promptName: string, functionParams: unknown[]): SpanPlan[] {
  return [
    // 0: root workflow
    {
      name: promptName,
      kind: 'workflow',
      startOffset: 0,
      duration: 4100,
      attributes: { 'prompt.name': promptName, 'prompt.params': functionParams },
    },

    // 1: joke_creation task
    { name: 'joke_creation', kind: 'task', startOffset: 20, duration: 736, parentIndex: 0 },
    // 2: openai chat under joke_creation
    {
      name: 'openai',
      kind: 'chat',
      startOffset: 30,
      duration: 735,
      parentIndex: 1,
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a pirate.' },
          { role: 'user', content: 'Tell me a short pirate joke.' },
        ],
        output: 'Why did the pirate go to school? To improve his "arrrr-ticulation"!',
        promptTokens: 28,
        completionTokens: 22,
        totalTokens: 50,
        cost: 0.00041,
        parameters: { temperature: 0.8 },
      },
    },

    // 3: joke_translation agent
    { name: 'joke_translation', kind: 'agent', startOffset: 780, duration: 2100, parentIndex: 0 },
    // 4: openai chat
    {
      name: 'openai',
      kind: 'chat',
      startOffset: 800,
      duration: 848,
      parentIndex: 3,
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a translator who preserves wordplay.' },
          { role: 'user', content: 'Translate the joke into French.' },
        ],
        output: "Pourquoi le pirate est-il allé à l'école? Pour améliorer son \"arrrr-ticulation\"!",
        promptTokens: 54,
        completionTokens: 28,
        totalTokens: 82,
        cost: 0.00063,
      },
    },
    // 5: history_jokes tool
    {
      name: 'history_jokes',
      kind: 'tool',
      startOffset: 1700,
      duration: 1300,
      parentIndex: 3,
      attributes: { 'tool.input': { topic: 'pirates', count: 3 }, 'tool.output.size': 3 },
    },
    // 6: openai chat under history_jokes (reformulating based on historical jokes)
    {
      name: 'openai',
      kind: 'chat',
      startOffset: 1720,
      duration: 1270,
      parentIndex: 5,
      llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Summarise historical pirate jokes.' },
          { role: 'user', content: 'Return a short summary.' },
        ],
        output: 'Historical pirate jokes often revolve around treasure, parrots, and bad puns.',
        promptTokens: 90,
        completionTokens: 40,
        totalTokens: 130,
        cost: 0.0008,
      },
    },

    // 7: signature_generation task
    { name: 'signature_generation', kind: 'task', startOffset: 3400, duration: 648, parentIndex: 0 },
    // 8: completion (raw) under signature_generation
    {
      name: 'openai',
      kind: 'completion',
      startOffset: 3420,
      duration: 647,
      parentIndex: 7,
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        output: '— Captain Blackbeard',
        promptTokens: 18,
        completionTokens: 6,
        totalTokens: 24,
        cost: 0.00012,
      },
    },
  ];
}

/**
 * In-memory {@link TraceProvider} that generates a synthetic waterfall for
 * every prompt execution. Useful for tests and for exercising the UI without
 * hooking up a real tracing backend.
 */
export class DummyTraceProvider implements TraceProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;

  private traces = new Map<string, Trace>();
  private spansByTrace = new Map<string, Span[]>();
  private subscribers = new Map<string, Set<(event: TraceStreamEvent) => void>>();
  private watchers = new Set<(event: TraceChangeEvent) => void>();
  private nextTraceSeq = 0;

  constructor(options: { id?: string; displayName?: string; description?: string } = {}) {
    this.id = options.id ?? 'dummy';
    this.displayName = options.displayName ?? 'Dummy Traces';
    this.description = options.description ?? 'Synthetic traces for UI testing.';
  }

  async getAllTraces(): Promise<TraceSummary[]> {
    const summaries = Array.from(this.traces.values()).map(t => ({
      id: t.id,
      providerId: this.id,
      name: t.name,
      startTime: t.startTime,
      endTime: t.endTime,
      status: t.status,
      spanCount: this.spansByTrace.get(t.id)?.length ?? 0,
    }));
    summaries.sort((a, b) => b.startTime - a.startTime);
    return summaries;
  }

  async getTrace(traceId: string): Promise<TraceWithSpans | null> {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    return { trace, spans: this.spansByTrace.get(traceId) ?? [] };
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
    return () => { this.watchers.delete(callback); };
  }

  async beginPromptTrace(info: BeginPromptTraceInfo): Promise<Trace> {
    const now = Date.now();
    const traceId = `dummy-${now}-${++this.nextTraceSeq}`;
    const trace: Trace = {
      id: traceId,
      providerId: this.id,
      name: info.promptName,
      startTime: now,
      status: 'running',
      attributes: {
        'prompt.providerId': info.promptProviderId,
        'prompt.id': info.promptId,
      },
    };
    this.traces.set(traceId, trace);
    this.spansByTrace.set(traceId, []);
    this.emitChange({ type: 'add', traceId });

    this.simulate(traceId, now, buildPlan(info.promptName, info.functionParams));

    return trace;
  }

  private simulate(traceId: string, startEpoch: number, plan: SpanPlan[]): void {
    const plannedSpans: Span[] = plan.map((entry, index) => ({
      id: `${traceId}-s${index}`,
      traceId,
      parentId: entry.parentIndex !== undefined ? `${traceId}-s${entry.parentIndex}` : undefined,
      name: entry.name,
      kind: entry.kind,
      startTime: startEpoch + entry.startOffset,
      endTime: undefined,
      status: undefined,
      attributes: entry.attributes,
      llm: entry.llm,
    }));

    // Speed up simulation so a tester doesn't have to wait 4 seconds per trace.
    const speed = 1; // 1 = realtime, larger = faster

    for (const [index, entry] of plan.entries()) {
      const span = plannedSpans[index];
      setTimeout(() => {
        const current = this.traces.get(traceId);
        if (!current) return;
        this.spansByTrace.get(traceId)!.push(span);
        this.emitStream(traceId, { type: 'span-start', span });
      }, entry.startOffset / speed);

      setTimeout(() => {
        const current = this.traces.get(traceId);
        if (!current) return;
        const ended: Span = {
          ...span,
          endTime: startEpoch + entry.startOffset + entry.duration,
          status: 'ok',
        };
        const spans = this.spansByTrace.get(traceId)!;
        const idx = spans.findIndex(s => s.id === span.id);
        if (idx >= 0) spans[idx] = ended;
        this.emitStream(traceId, { type: 'span-end', span: ended });
      }, (entry.startOffset + entry.duration) / speed);
    }

    // Root span duration drives the overall trace end
    const total = plan[0].duration;
    setTimeout(() => {
      const trace = this.traces.get(traceId);
      if (!trace) return;
      const ended: Trace = { ...trace, endTime: startEpoch + total, status: 'ok' };
      this.traces.set(traceId, ended);
      this.emitStream(traceId, { type: 'trace-end', trace: ended });
      this.emitChange({ type: 'update', traceId });
    }, total / speed);
  }

  private emitStream(traceId: string, event: TraceStreamEvent): void {
    const set = this.subscribers.get(traceId);
    if (!set) return;
    for (const cb of set) {
      try { cb(event); } catch (err) { console.error('Trace subscriber threw:', err); }
    }
  }

  private emitChange(event: TraceChangeEvent): void {
    for (const cb of this.watchers) {
      try { cb(event); } catch (err) { console.error('Trace watcher threw:', err); }
    }
  }
}
