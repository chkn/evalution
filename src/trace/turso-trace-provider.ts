// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * {@link TraceProvider} backed by a Turso/libSQL database — the local default
 * (replacing {@link MemoryTraceProvider}) that also carries forward into the
 * cloud via `@tursodatabase/sync`'s deferred-sync story. See
 * `specs/trace-workshopping.md` §B.
 */

import type { Database } from "@tursodatabase/sync";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { annotations, spans, traces } from "./db/schema.ts";
import { mergeSpans } from "./span-merge.ts";
import type { TraceIngestor } from "./trace-ingestor.ts";
import { BaseTraceProvider } from "./trace-sink.ts";
import type {
  Annotation,
  LLMSpanDetails,
  Span,
  SpanKind,
  SpanMessage,
  Trace,
  TraceSummary,
} from "./trace-types.ts";

function parseJson<T>(v: string | null): T | undefined {
  return v == null ? undefined : (JSON.parse(v) as T);
}

// ── traces ──────────────────────────────────────────────────────────────

function traceToRow(trace: Trace) {
  return {
    id: trace.id,
    providerId: trace.providerId ?? null,
    name: trace.name,
    startTime: trace.startTime,
    endTime: trace.endTime ?? null,
    status: trace.status,
    attributes: trace.attributes ? JSON.stringify(trace.attributes) : null,
  };
}

function rowToTrace(row: typeof traces.$inferSelect): Trace {
  return {
    id: row.id,
    ...(row.providerId && { providerId: row.providerId }),
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime ?? undefined,
    status: row.status,
    attributes: parseJson(row.attributes),
  };
}

// ── spans ───────────────────────────────────────────────────────────────

function spanToRow(span: Span) {
  return {
    id: span.id,
    traceId: span.traceId,
    parentId: span.parentId ?? null,
    name: span.name,
    kind: span.kind,
    startTime: span.startTime,
    endTime: span.endTime ?? null,
    status: span.status ?? null,
    errorMessage: span.errorMessage ?? null,
    llmProvider: span.llm?.provider ?? null,
    llmModel: span.llm?.model ?? null,
    llmPromptTokens: span.llm?.promptTokens ?? null,
    llmCompletionTokens: span.llm?.completionTokens ?? null,
    llmTotalTokens: span.llm?.totalTokens ?? null,
    llmCost: span.llm?.cost ?? null,
    llmMessages: span.llm?.messages ? JSON.stringify(span.llm.messages) : null,
    llmOutput: span.llm?.output ?? null,
    llmParameters: span.llm?.modelParameters
      ? JSON.stringify(span.llm.modelParameters)
      : null,
    attributes: span.attributes ? JSON.stringify(span.attributes) : null,
    prompt: span.prompt ? JSON.stringify(span.prompt) : null,
    tool: span.tool ? JSON.stringify(span.tool) : null,
  };
}

function rowToSpan(row: typeof spans.$inferSelect): Span {
  const llm: LLMSpanDetails = {
    ...(row.llmProvider && { provider: row.llmProvider }),
    ...(row.llmModel && { model: row.llmModel }),
    ...(row.llmPromptTokens != null && { promptTokens: row.llmPromptTokens }),
    ...(row.llmCompletionTokens != null && {
      completionTokens: row.llmCompletionTokens,
    }),
    ...(row.llmTotalTokens != null && { totalTokens: row.llmTotalTokens }),
    ...(row.llmCost != null && { cost: row.llmCost }),
    ...(row.llmMessages && {
      messages: parseJson<SpanMessage[]>(row.llmMessages),
    }),
    ...(row.llmOutput && { output: row.llmOutput }),
    ...(row.llmParameters && {
      modelParameters: parseJson<Record<string, unknown>>(row.llmParameters),
    }),
  };
  // Only attach `llm` when some LLM column is actually non-null — a
  // native-telemetry TOOL span, say, should not grow an empty `llm: {}`.
  const hasLlm = Object.keys(llm).length > 0;

  return {
    id: row.id,
    traceId: row.traceId,
    parentId: row.parentId ?? undefined,
    name: row.name,
    kind: row.kind as SpanKind,
    startTime: row.startTime,
    endTime: row.endTime ?? undefined,
    status: row.status ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    attributes: parseJson(row.attributes),
    ...(hasLlm && { llm }),
    prompt: parseJson(row.prompt),
    tool: parseJson(row.tool),
  };
}

// ── annotations ─────────────────────────────────────────────────────────

function annotationToRow(a: Annotation) {
  return {
    id: a.id,
    traceId: a.traceId,
    spanId: a.spanId ?? null,
    kind: a.kind,
    note: a.note,
    source: a.source,
    createdAt: a.createdAt,
  };
}

function rowToAnnotation(row: typeof annotations.$inferSelect): Annotation {
  return {
    id: row.id,
    traceId: row.traceId,
    spanId: row.spanId ?? undefined,
    kind: row.kind,
    note: row.note,
    source: row.source,
    createdAt: row.createdAt,
  };
}

/**
 * `TraceProvider` backed by a Turso/libSQL database via
 * `drizzle-orm/tursodatabase-sync`. Takes an already-connected
 * `@tursodatabase/sync` client — never a path — so this class stays fs-free;
 * the Node CLI bootstrap (`createLocalTursoClient`) is where a real path gets
 * involved. Migrations are *not* run here — call `runMigrations` (from
 * `./db/migrate.ts`) against the same client before constructing this, or
 * queries will fail against an empty database.
 */
export class TursoTraceProvider extends BaseTraceProvider {
  private readonly db: ReturnType<
    typeof drizzle<Record<string, never>, Database>
  >;

  /** Tail of the serialized-write chain — see `serializeWrite` below. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor({
    client,
    id = "turso",
    displayName = "Traces",
    description = "Stores traces in a local (optionally synced) SQLite database.",
    ingestors = [],
  }: {
    /** An already-connected `@tursodatabase/sync` client. */
    client: Database;
    id?: string;
    displayName?: string;
    description?: string;
    /** Ingestors to connect to this provider as a sink. */
    ingestors?: TraceIngestor[];
  }) {
    super({ id, displayName, description });
    this.db = drizzle({ client });
    for (const ingestor of ingestors) ingestor.addSink(this);
  }

  /**
   * Runs a write to completion before the next one starts. The client is a
   * single connection, so overlapping `db.transaction()` calls fail outright
   * ("cannot start a transaction within a transaction") and a plain write
   * issued mid-transaction would silently join — and roll back with — that
   * transaction. Overlap is the norm, not the exception: `BaseTraceIngestor`
   * fans a span out to its sinks with `Promise.all`, and `OTelTraceIngestor`'s
   * `onStart`/`onEnd` are fire-and-forget per span, so any two spans that
   * start or end in the same tick land here concurrently.
   */
  private serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writes.then(write, write);
    // Keep the chain alive after a failed write (and never leave an unhandled
    // rejection behind); the failure still surfaces to `next`'s awaiter.
    this.writes = next.catch(() => {});
    return next;
  }

  async getAllTraces(): Promise<TraceSummary[]> {
    // A raw correlated-subquery column (`sql\`... where ${spans.traceId} =
    // ${traces.id}\``) renders both sides unqualified ("trace_id" = "id"),
    // which SQLite resolves against the innermost table in scope — silently
    // comparing `spans.trace_id` to `spans.id` instead of `traces.id`, so
    // every count came back 0. A `leftJoin` to a grouped subquery goes
    // through Drizzle's own qualification instead, and doubles as the
    // zero-spans case (a trace with no matching row still gets counted, via
    // `coalesce`).
    const spanCounts = this.db
      .select({ traceId: spans.traceId, count: sql`count(*)`.as("count") })
      .from(spans)
      .groupBy(spans.traceId)
      .as("span_counts");

    const rows = await this.db
      .select({
        id: traces.id,
        providerId: traces.providerId,
        name: traces.name,
        startTime: traces.startTime,
        endTime: traces.endTime,
        status: traces.status,
        spanCount: sql<number>`coalesce(${spanCounts.count}, 0)`,
      })
      .from(traces)
      .leftJoin(spanCounts, eq(spanCounts.traceId, traces.id))
      .orderBy(desc(traces.startTime));

    return rows.map(row => ({
      id: row.id,
      providerId: row.providerId ?? this.id,
      name: row.name,
      startTime: row.startTime,
      endTime: row.endTime ?? undefined,
      status: row.status,
      spanCount: Number(row.spanCount),
    }));
  }

  async hasTrace(traceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: traces.id })
      .from(traces)
      .where(eq(traces.id, traceId));
    return !!row;
  }

  protected async getTraceWithoutSpans(
    traceId: string,
  ): Promise<Trace | undefined> {
    const [row] = await this.db
      .select()
      .from(traces)
      .where(eq(traces.id, traceId));
    return row ? rowToTrace(row) : undefined;
  }

  protected async getTraceSpans(traceId: string): Promise<Span[]> {
    const rows = await this.db
      .select()
      .from(spans)
      .where(eq(spans.traceId, traceId));
    return rows.map(rowToSpan);
  }

  protected async addOrUpdateTrace(trace: Trace): Promise<void> {
    const row = traceToRow(trace);
    await this.serializeWrite(() =>
      this.db
        .insert(traces)
        .values(row)
        .onConflictDoUpdate({ target: traces.id, set: row }),
    );
  }

  /**
   * Reads any existing row, merges the incoming snapshot into it (via
   * `mergeSpans`, the same helper every in-memory sink uses), writes the
   * merged row back, and returns it — all inside one transaction (and one
   * `serializeWrite` slot), so a concurrent write can't interleave
   * between the read and the write.
   */
  protected async addOrUpdateSpan(span: Span): Promise<Span> {
    return this.serializeWrite(() =>
      this.db.transaction(async tx => {
        const [existingRow] = await tx
          .select()
          .from(spans)
          .where(eq(spans.id, span.id));
        const merged = existingRow
          ? mergeSpans(rowToSpan(existingRow), span)
          : span;
        const row = spanToRow(merged);
        await tx
          .insert(spans)
          .values(row)
          .onConflictDoUpdate({ target: spans.id, set: row });
        return merged;
      }),
    );
  }

  // ── annotation store ─────────────────────────────────────────────────
  // Not part of the `TraceProvider`/`TraceSink` interfaces (those stay
  // storage-agnostic); the live-update/REST wiring that calls these lands in
  // §0d/§0e once the broadcast side exists.

  /** Lists every annotation on a trace, oldest first. */
  async listAnnotations(traceId: string): Promise<Annotation[]> {
    const rows = await this.db
      .select()
      .from(annotations)
      .where(eq(annotations.traceId, traceId))
      .orderBy(annotations.createdAt);
    return rows.map(rowToAnnotation);
  }

  /** Creates a new annotation, minting its `id`/`createdAt`. */
  async createAnnotation(
    input: Omit<Annotation, "id" | "createdAt">,
  ): Promise<Annotation> {
    const annotation: Annotation = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    await this.serializeWrite(() =>
      this.db.insert(annotations).values(annotationToRow(annotation)),
    );
    return annotation;
  }

  /** Deletes an annotation by id. A no-op if it doesn't exist. */
  async deleteAnnotation(id: string): Promise<void> {
    await this.serializeWrite(() =>
      this.db.delete(annotations).where(eq(annotations.id, id)),
    );
  }
}
