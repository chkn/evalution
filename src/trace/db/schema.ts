// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Drizzle sqlite-core schema backing {@link TursoTraceProvider}. See
 * `specs/trace-workshopping.md` §B.1 — promotes to columns whatever the
 * provider needs to query (tree-build, ordering, summary/cost rollups) and
 * JSONs the display-only, variable-shape fields.
 * fs-free by construction (no `better-sqlite3`/`node:*` imports) so it stays
 * usable from a Workers bundle.
 */

import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * One {@link Trace}. `attributes` is the trace's free-form attribute bag,
 * JSON-encoded.
 */
export const traces = sqliteTable(
  "traces",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id"),
    name: text("name").notNull(),
    /** Start timestamp (ms). */
    startTime: real("start_time").notNull(),
    /** End timestamp (ms), NULL while the trace is still running. */
    endTime: real("end_time"),
    status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
    attributes: text("attributes"),
  },
  t => [index("idx_traces_start_time").on(t.startTime)],
);

/**
 * One {@link Span}. LLM fields that are cheap, fixed-shape, and worth
 * querying/summing directly (model, token counts, cost) are promoted to
 * columns; the rest (messages, output, parameters, free-form attributes,
 * prompt reference, tool call) are JSON blobs — `attributes` is legitimately
 * NULL for a native-telemetry span, which carries no OTel attribute bag at
 * all (see `specs/trace-workshopping.md` "Key findings that shape the
 * approach").
 */
export const spans = sqliteTable(
  "spans",
  {
    id: text("id").primaryKey(),
    /**
     * Deliberately *not* a foreign key: {@link BaseTraceProvider.recordSpanStart}
     * (see `trace-sink.ts`) can persist a non-root span before its trace row
     * exists (out-of-order arrival) — a `NOT NULL` FK here would reject that
     * insert. Cascade-on-delete is instead enforced by the
     * `trg_spans_cascade_delete_trace` trigger (see the initial migration).
     */
    traceId: text("trace_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** Start timestamp (ms). */
    startTime: real("start_time").notNull(),
    /** End timestamp (ms), NULL while the span is still running. */
    endTime: real("end_time"),
    status: text("status", { enum: ["ok", "error"] }),
    errorMessage: text("error_message"),

    llmProvider: text("llm_provider"),
    llmModel: text("llm_model"),
    llmPromptTokens: integer("llm_prompt_tokens"),
    llmCompletionTokens: integer("llm_completion_tokens"),
    llmTotalTokens: integer("llm_total_tokens"),
    llmCostPrompt: real("llm_cost_prompt"),
    llmCostCompletion: real("llm_cost_completion"),
    /** JSON `SpanMessage[]`. */
    llmMessages: text("llm_messages"),
    llmOutput: text("llm_output"),
    /** JSON `Record<string, unknown>`. */
    llmParameters: text("llm_parameters"),

    /** JSON `Record<string, unknown>`. */
    attributes: text("attributes"),
    /** JSON `PromptID`. */
    prompt: text("prompt"),
    /** JSON `ToolSpanDetails`. */
    tool: text("tool"),
  },
  t => [
    index("idx_spans_trace_id").on(t.traceId),
    index("idx_spans_parent_id").on(t.parentId),
  ],
);

export const annotations = sqliteTable(
  "annotations",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    /** The span this annotation is attached to, or NULL for a trace-level annotation. */
    spanId: text("span_id"),
    kind: text("kind", { enum: ["issue", "good", "note"] }).notNull(),
    note: text("note").notNull(),
    source: text("source", {
      enum: ["user", "claude-code", "codex"],
    }).notNull(),
    /** Creation timestamp (ms). */
    createdAt: real("created_at").notNull(),
  },
  t => [index("idx_annotations_trace_id").on(t.traceId)],
);
