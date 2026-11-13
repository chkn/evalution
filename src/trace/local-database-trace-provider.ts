// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { access, constants } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  Annotation,
  AnnotationChanges,
  Span,
  Trace,
  TraceQuery,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "@evalution/sdk";
import type { Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import type { DatabaseSync } from "../sync/database-sync.ts";
import {
  type LocalDatabaseSync,
  openLocalDatabase,
  startSyncing,
} from "../sync/local-database.ts";
import { PauseGate } from "../sync/pause-gate.ts";
import type { WorkspaceSync } from "../sync/workspace-sync.ts";
import { BaseTraceProvider } from "./base-trace-provider.ts";
import { runMigrations, TRACE_SCHEMA_VERSION } from "./db/migrate.ts";
import { TRACE_QUERY_SCHEMA } from "./db/query-schema.ts";
import { runQueryInWorker } from "./db/query-worker.ts";
import {
  SqlQueryError,
  type SqlQueryOptions,
  type SqlQueryResult,
} from "./db/read-only-query.ts";
import { mkdirSelfIgnoring } from "./db/self-ignoring-dir.ts";
import type { TraceProvider } from "./trace-provider.ts";
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
  /**
   * Also names the database in Evalution Cloud when the project is linked:
   * changing it starts a new cloud copy.
   */
  id?: string;
  displayName?: string;
  description?: string;
}

const migrate = (client: Database) => runMigrations(drizzle({ client }));

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

  private sync: DatabaseSync | undefined;
  /** The open file, for sync. */
  private client: Database | undefined;
  /** Holds operations while sync swaps the database file. */
  private readonly gate = new PauseGate();
  private unwatchReal: (() => void) | undefined;

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

  /**
   * Syncs the database with the linked project's copy (named by this
   * provider's id), once `setUpProject` hands this the project's sync. Opens
   * (and creates) the database at once, since the project may already have
   * traces from another machine; a database already open starts syncing as
   * it is.
   *
   * @internal Not public API yet.
   */
  _ecSetSync(workspace: WorkspaceSync): void {
    if (this.sync) return;
    this.sync = workspace.database(
      { kind: "traces", provider: this.id },
      TRACE_SCHEMA_VERSION,
    );
    if (this.openFailure) return;
    this.creating = (
      this.real
        ? Promise.resolve(this.real)
        : (this.creating ?? Promise.resolve(undefined))
    ).then(async existing => {
      if (!existing)
        return this.open().catch(err => this.reportOpenFailure(err));
      await this.startSyncing().catch(err =>
        console.warn(`⚠️ Couldn't start syncing ${this.path}:`, err),
      );
      return existing;
    });
  }

  /** What syncing the file needs, once there's a sync. */
  private syncHooks(): LocalDatabaseSync | undefined {
    const database = this.sync;
    return (
      database && {
        database,
        // What a pull brings in names no trace: say the list has changed.
        onPulled: () => this.emitChange({ type: "update", traceId: "" }),
        pause: during => this.gate.pause(during),
        reopen: () => this.reopen(),
      }
    );
  }

  /** Starts syncing the open file. */
  private async startSyncing(): Promise<void> {
    const sync = this.syncHooks();
    const client = this.client;
    if (!sync || !client) return;
    await sync.database.prepare();
    await startSyncing({ path: this.path, client, migrate, sync });
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
    // A directory this creates ignores itself, so traces stay out of git
    // without anyone editing their `.gitignore`.
    await mkdirSelfIgnoring(dirname(this.path));
    // Before connecting, so a database new to this machine starts from the
    // cloud's copy.
    await this.sync?.prepare();
    const client = await openLocalDatabase({
      path: this.path,
      migrate,
      sync: () => this.syncHooks(),
    });
    this.client = client;
    const real = new TursoTraceProvider({
      client,
      runQuery: (query, options) => runQueryInWorker(this.path, query, options),
      id: this.id,
      displayName: this.displayName,
      description: this.description,
    });
    this.real = real;
    this.unwatchReal = real.watch(event => this.emitChange(event));
    for (const traceId of this.subscribers.keys())
      this.bridgeTrace(real, traceId);
    return real;
  }

  /** Opens the database again, after sync swapped its file (and closed the old one). */
  private reopen(): Promise<unknown> {
    this.unwatchReal?.();
    for (const unsubscribe of this.bridgedTraceUnsubscribes.values()) {
      unsubscribe();
    }
    this.bridgedTraceUnsubscribes.clear();
    this.real = undefined;
    this.client = undefined;
    this.creating = undefined;
    return this.ensureReal();
  }

  /** `result`, after telling the sync the database was written to. */
  private wrote<T>(result: T): T {
    this.sync?.noteWrite();
    return result;
  }

  private bridgeTrace(real: TursoTraceProvider, traceId: string): void {
    if (this.bridgedTraceUnsubscribes.has(traceId)) return;
    const unsubscribe = real.subscribeTrace(traceId, event =>
      this.emitStream(traceId, event),
    );
    this.bridgedTraceUnsubscribes.set(traceId, unsubscribe);
  }

  // ── TraceProvider (read) — never opens the database ─────────────────────

  override getAllTraces(query?: TraceQuery): Promise<TraceSummary[]> {
    return this.gate.run(
      async () => (await this.currentReal())?.getAllTraces(query) ?? [],
    );
  }

  override hasTrace(traceId: string): Promise<boolean> {
    return this.gate.run(
      async () => (await this.currentReal())?.hasTrace(traceId) ?? false,
    );
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

  protected override removeTrace(): Promise<void> {
    throw new Error("should not be called");
  }

  /**
   * Deletes a trace, its spans and its annotations. Returns `false` if the database
   * was never created. The `remove` event reaches this provider's watchers
   * through the bridge set up when the database is opened.
   */
  override deleteTrace(traceId: string): Promise<boolean> {
    return this.gate.run(async () =>
      this.wrote(
        (await (await this.currentReal())?.deleteTrace(traceId)) ?? false,
      ),
    );
  }

  /**
   * Runs one read-only query — see {@link TursoTraceProvider.query}. With no
   * database yet there is nothing to query, and opening one to find that out
   * would create the file, so this says so instead.
   */
  query(sql: string, options?: SqlQueryOptions): Promise<SqlQueryResult> {
    return this.gate.run(() => this.queryNow(sql, options));
  }

  private async queryNow(
    sql: string,
    options?: SqlQueryOptions,
  ): Promise<SqlQueryResult> {
    const real = await this.currentReal();
    if (!real) {
      throw new SqlQueryError(
        this.openFailure
          ? `The trace database at ${this.path} could not be opened: ${this.openFailure.message}`
          : "No traces have been recorded yet, so there is nothing to query.",
      );
    }
    return real.query(sql, options);
  }

  /** The tables {@link query} runs against. */
  getQuerySchema(): string {
    return TRACE_QUERY_SCHEMA;
  }

  /**
   * The trace with its spans. When syncing, a trace that isn't here is
   * pulled for once before it's reported missing: it may be a shared link to
   * one recorded on another machine.
   */
  override getTrace(traceId: string): Promise<TraceWithSpans | undefined> {
    return this.gate.run(async () => {
      const real = await this.currentReal();
      const found = await real?.getTrace(traceId);
      if (found || !real || !this.sync) return found;
      return (await this.sync.pull()) ? real.getTrace(traceId) : undefined;
    });
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

  override recordSpanStart(span: Span): Promise<Span> {
    return this.gate.run(async () =>
      this.wrote(
        (await (await this.ensureReal())?.recordSpanStart(span)) ?? span,
      ),
    );
  }

  override recordSpanEnd(span: Span): Promise<Span> {
    return this.gate.run(async () =>
      this.wrote(
        (await (await this.ensureReal())?.recordSpanEnd(span)) ?? span,
      ),
    );
  }

  override failTrace(traceId: string, errorMessage: string): Promise<void> {
    return this.gate.run(async () => {
      this.wrote(
        await (await this.ensureReal())?.failTrace(traceId, errorMessage),
      );
    });
  }

  // ── annotation store — mirrors `TursoTraceProvider`'s (see its own docs) ─

  /** Lists every annotation on a trace, oldest first. Empty if nothing has been saved yet. */
  listAnnotations(traceId: string): Promise<Annotation[]> {
    return this.gate.run(
      async () => (await this.currentReal())?.listAnnotations(traceId) ?? [],
    );
  }

  /**
   * Creates a new annotation, minting its `id`/`createdAt`. Unlike span
   * recording, this throws when the database can't be opened — someone asked
   * for this note to be saved, so dropping it silently would be worse than
   * the error.
   */
  createAnnotation(
    input: Omit<Annotation, "id" | "createdAt">,
  ): Promise<Annotation> {
    return this.gate.run(async () => {
      const real = await this.ensureReal();
      if (!real) {
        throw new Error(
          `Cannot save an annotation: the trace database at ${this.path} could not be opened.`,
          { cause: this.openFailure },
        );
      }
      return this.wrote(await real.createAnnotation(input));
    });
  }

  /**
   * Changes an annotation's `kind` and/or `note`. `undefined` if it doesn't
   * exist — including when the database was never created.
   */
  updateAnnotation(
    id: string,
    changes: AnnotationChanges,
  ): Promise<Annotation | undefined> {
    return this.gate.run(async () =>
      this.wrote(
        await (await this.currentReal())?.updateAnnotation(id, changes),
      ),
    );
  }

  /** Deletes an annotation by id. A no-op if the database was never created. */
  deleteAnnotation(id: string): Promise<void> {
    return this.gate.run(async () => {
      this.wrote(await (await this.currentReal())?.deleteAnnotation(id));
    });
  }
}
