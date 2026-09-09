// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { access, constants, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { createLocalTursoClient } from "./db/local-turso-client.ts";
import { runMigrations } from "./db/migrate.ts";
import type { TraceIngestor } from "./trace-ingestor.ts";
import type { TraceProvider } from "./trace-provider.ts";
import { BaseTraceProvider } from "./trace-sink.ts";
import type {
  Annotation,
  Span,
  Trace,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "./trace-types.ts";
import { TursoTraceProvider } from "./turso-trace-provider.ts";

/** Default path (relative to CWD), matching {@link LocalDatabaseTraceProviderOptions.path}'s default. */
const DEFAULT_PATH = "./.evalution/traces/local.db";

/**
 * Resolves {@link LocalDatabaseTraceProviderOptions.path} (or its default)
 * against the current working directory. Pure — split out from the
 * constructor so path-resolution can be tested without touching the
 * filesystem (the constructor's own resolution has the side effect of
 * probing — and potentially opening — whatever file the result names).
 */
export function resolveDbPath(path: string | undefined): string {
  return resolve(path ?? DEFAULT_PATH);
}

export interface LocalDatabaseTraceProviderOptions {
  /**
   * Path to the local SQLite file. Absolute, or relative to the current working directory.
   *
   * @default "./.evalution/traces/local.db"
   */
  path?: string;
  id?: string;
  displayName?: string;
  description?: string;
  /** Ingestors to connect to this provider as a sink. */
  ingestors?: TraceIngestor[];
}

/**
 * A {@link TraceProvider} that lazily opens a {@link TursoTraceProvider} over
 * a local SQLite file, creating the file (and its parent directory) only when
 * there's a trace or span to actually save.
 */
export class LocalDatabaseTraceProvider extends BaseTraceProvider {
  /** The resolved (absolute) path this provider opens — see {@link LocalDatabaseTraceProviderOptions.path}. */
  readonly path: string;

  private readonly ingestors: TraceIngestor[];
  private real: TursoTraceProvider | undefined;
  private creating: Promise<TursoTraceProvider | undefined> | undefined;

  private readonly bridgedTraceUnsubscribes = new Map<string, () => void>();

  constructor(options: LocalDatabaseTraceProviderOptions = {}) {
    super({
      id: options.id ?? "local-db",
      displayName: options.displayName ?? "Local Database",
      description:
        options.description ?? "Stores traces in a local SQLite database.",
    });
    this.path = resolveDbPath(options.path);
    this.ingestors = options.ingestors ?? [];
    for (const ingestor of this.ingestors) ingestor.addSink(this);

    // Fire-and-forget: a constructor can't be async. Errors surface on the
    // next read/write that awaits `ensureReal`/`currentReal` anyway, since
    // `this.creating` stays rejected and every caller awaits the same
    // promise.
    this.creating = access(this.path, constants.R_OK | constants.W_OK).then(
      () => this.open(),
      () => undefined, // if we can't access the file, eat the error for now (we try to open it again later)
    );
  }

  /** The live provider if one exists, awaiting an already-in-flight open — but never starting one. */
  private async currentReal(): Promise<TursoTraceProvider | undefined> {
    return this.real ?? this.creating;
  }

  /**
   * The live provider, opening (and, on first write, creating) the database
   * file if needed. Deliberately *not* `async`: `this.creating` is replaced
   * synchronously, before the first `await`, so concurrent first writes all
   * chain onto the same open instead of each starting their own — two sync
   * clients over one file fail outright with "database is busy".
   */
  private ensureReal(): Promise<TursoTraceProvider> {
    if (this.real) return Promise.resolve(this.real);
    const opening = (this.creating ?? Promise.resolve(undefined)).then(
      existing => existing ?? this.open(),
    );
    this.creating = opening;
    return opening;
  }

  private async open(): Promise<TursoTraceProvider> {
    await mkdir(dirname(this.path), { recursive: true });
    const client = await createLocalTursoClient({ path: this.path });
    await runMigrations(drizzle({ client }));
    const real = new TursoTraceProvider({
      client,
      id: this.id,
      displayName: this.displayName,
      description: this.description,
    });
    this.real = real;
    real.watch(event => this.emitChange(event));
    for (const traceId of this.subscribers.keys())
      this.bridgeTrace(real, traceId);
    return real;
  }

  private bridgeTrace(real: TursoTraceProvider, traceId: string): void {
    if (this.bridgedTraceUnsubscribes.has(traceId)) return;
    const unsubscribe = real.subscribeTrace(traceId, event =>
      this.emitStream(traceId, event),
    );
    this.bridgedTraceUnsubscribes.set(traceId, unsubscribe);
  }

  // ── TraceProvider (read) — never opens the database ─────────────────────

  override async getAllTraces(): Promise<TraceSummary[]> {
    return (await this.currentReal())?.getAllTraces() ?? [];
  }

  override async hasTrace(traceId: string): Promise<boolean> {
    return (await this.currentReal())?.hasTrace(traceId) ?? false;
  }

  protected override getTraceWithoutSpans(): Promise<Trace | undefined> {
    throw new Error("should not be called");
  }

  protected override getTraceSpans(): Promise<Span[]> {
    throw new Error("should not be called");
  }

  protected override addOrUpdateTrace(): Promise<void> {
    throw new Error("should not be called");
  }

  protected override addOrUpdateSpan(): Promise<Span> {
    throw new Error("should not be called");
  }

  override async getTrace(
    traceId: string,
  ): Promise<TraceWithSpans | undefined> {
    return (await this.currentReal())?.getTrace(traceId);
  }

  override subscribeTrace(
    traceId: string,
    callback: (event: TraceStreamEvent) => void,
  ): () => void {
    const superUnsubscribe = super.subscribeTrace(traceId, callback);
    if (this.real) this.bridgeTrace(this.real, traceId);
    return () => {
      superUnsubscribe();
      if (!this.subscribers.has(traceId)) {
        this.bridgedTraceUnsubscribes.get(traceId)?.();
        this.bridgedTraceUnsubscribes.delete(traceId);
      }
    };
  }

  // ── TraceSink (write) — opens (and creates, on first write) the database ─

  override async recordSpanStart(span: Span): Promise<Span> {
    return (await this.ensureReal()).recordSpanStart(span);
  }

  override async recordSpanEnd(span: Span): Promise<Span> {
    return (await this.ensureReal()).recordSpanEnd(span);
  }

  override async failTrace(
    traceId: string,
    errorMessage: string,
  ): Promise<void> {
    await (await this.ensureReal()).failTrace(traceId, errorMessage);
  }

  // ── annotation store — mirrors `TursoTraceProvider`'s (see its own docs) ─

  /** Lists every annotation on a trace, oldest first. Empty if nothing has been saved yet. */
  async listAnnotations(traceId: string): Promise<Annotation[]> {
    return (await this.currentReal())?.listAnnotations(traceId) ?? [];
  }

  /** Creates a new annotation, minting its `id`/`createdAt`. */
  async createAnnotation(
    input: Omit<Annotation, "id" | "createdAt">,
  ): Promise<Annotation> {
    return (await this.ensureReal()).createAnnotation(input);
  }

  /** Deletes an annotation by id. A no-op if the database was never created. */
  async deleteAnnotation(id: string): Promise<void> {
    await (await this.currentReal())?.deleteAnnotation(id);
  }
}
