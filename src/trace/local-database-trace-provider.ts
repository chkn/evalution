// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { access, constants, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { createLocalTursoClient } from "./db/local-turso-client.ts";
import { runMigrations } from "./db/migrate.ts";
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
}

/**
 * A {@link TraceProvider} that lazily opens a {@link TursoTraceProvider} over
 * a local SQLite file, creating the file (and its parent directory) only when
 * there's a trace or span to actually save.
 */
export class LocalDatabaseTraceProvider extends BaseTraceProvider {
  /** The resolved (absolute) path this provider opens — see {@link LocalDatabaseTraceProviderOptions.path}. */
  readonly path: string;

  private real: TursoTraceProvider | undefined;
  private creating: Promise<TursoTraceProvider | undefined> | undefined;

  private readonly bridgedTraceUnsubscribes = new Map<string, () => void>();

  /**
   * The failure from an earlier {@link open}, if any. Kept so a database that
   * can't be opened fails fast on every later call rather than re-running
   * migrations — and re-logging the same stack — once per span.
   */
  private openFailure: Error | undefined;

  constructor(options: LocalDatabaseTraceProviderOptions = {}) {
    super({
      id: options.id ?? "local-db",
      displayName: options.displayName ?? "Local Database",
      description:
        options.description ?? "Stores traces in a local SQLite database.",
    });
    this.path = resolveDbPath(options.path);

    // Fire-and-forget: a constructor can't be async, and nothing awaits this
    // promise until the first read or write — so it must never reject, or an
    // unhandled rejection takes the process down before anyone can report it.
    // `reportOpenFailure` absorbs the error instead.
    this.creating = access(this.path, constants.R_OK | constants.W_OK).then(
      () => this.open().catch(err => this.reportOpenFailure(err)),
      () => undefined, // if we can't access the file, eat the error for now (we try to open it again later)
    );
  }

  /**
   * Reports — once — that the database could not be opened, and leaves this
   * provider inert. Deliberately not fatal: the trace store is a feature of
   * the playground, not a prerequisite for it, so a database left behind by
   * an older schema shouldn't stop anyone from editing and running prompts.
   * Explicit user actions still fail loudly (see {@link createAnnotation}).
   */
  private reportOpenFailure(err: unknown): undefined {
    if (this.openFailure) return undefined;
    this.openFailure = err instanceof Error ? err : new Error(String(err));
    console.error(
      `Could not open the trace database at ${this.path} — traces will not be recorded this session. ` +
        "If it was created by an older version of evalution, deleting it will start a fresh one.\n",
      this.openFailure,
    );
    return undefined;
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
  private ensureReal(): Promise<TursoTraceProvider | undefined> {
    if (this.real) return Promise.resolve(this.real);
    if (this.openFailure) return Promise.resolve(undefined);
    const opening = (this.creating ?? Promise.resolve(undefined)).then(
      existing =>
        existing ?? this.open().catch(err => this.reportOpenFailure(err)),
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

  // With no database to record into, a span passes through unchanged —
  // there is nothing stored to merge it with.

  override async recordSpanStart(span: Span): Promise<Span> {
    return (await this.ensureReal())?.recordSpanStart(span) ?? span;
  }

  override async recordSpanEnd(span: Span): Promise<Span> {
    return (await this.ensureReal())?.recordSpanEnd(span) ?? span;
  }

  override async failTrace(
    traceId: string,
    errorMessage: string,
  ): Promise<void> {
    await (await this.ensureReal())?.failTrace(traceId, errorMessage);
  }

  // ── annotation store — mirrors `TursoTraceProvider`'s (see its own docs) ─

  /** Lists every annotation on a trace, oldest first. Empty if nothing has been saved yet. */
  async listAnnotations(traceId: string): Promise<Annotation[]> {
    return (await this.currentReal())?.listAnnotations(traceId) ?? [];
  }

  /**
   * Creates a new annotation, minting its `id`/`createdAt`. Unlike span
   * recording, this throws when the database can't be opened — someone asked
   * for this note to be saved, so dropping it silently would be worse than
   * the error.
   */
  async createAnnotation(
    input: Omit<Annotation, "id" | "createdAt">,
  ): Promise<Annotation> {
    const real = await this.ensureReal();
    if (!real) {
      throw new Error(
        `Cannot save an annotation: the trace database at ${this.path} could not be opened.`,
        { cause: this.openFailure },
      );
    }
    return real.createAnnotation(input);
  }

  /** Deletes an annotation by id. A no-op if the database was never created. */
  async deleteAnnotation(id: string): Promise<void> {
    await (await this.currentReal())?.deleteAnnotation(id);
  }
}
