// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral handlers for reading, querying, and deleting traces —
 * resolved providers in, {@link HandlerResult} out — shared by the
 * `/api/traces` routes and the MCP server.
 */

import type { EvalProvider } from "../../eval/eval-provider.ts";
import type { EvalRunner } from "../../eval/eval-runner.ts";
import type { EvalTraceRun } from "../../eval/eval-types.ts";
import type { Span, TraceSummary } from "../../shared/types.ts";
import type { TraceProvider } from "../../trace/trace-provider.ts";
import { answerQuery } from "./query.ts";
import { errorResult, type HandlerResult } from "./result.ts";

const QUERY_UNSUPPORTED = errorResult(
  405,
  "This trace provider does not support SQL queries",
);

/** Where {@link handleListTraces} finds which eval run produced each trace. */
export interface TraceEvalRunSources {
  providers: Iterable<EvalProvider>;
  /** Knows the traces of runs in flight, whose rows aren't all recorded yet. */
  runner?: EvalRunner;
}

/** What the eval providers add to a trace's summary. */
type TraceEvalFields = Pick<TraceSummary, "evalRun" | "checkCounts">;

/**
 * Each trace an eval run produced, keyed `traceProviderId:traceId`. Never
 * throws: a provider that can't answer just leaves its traces ungrouped.
 * A run in flight only knows its traces, so what's recorded of their checks
 * survives it being added after the providers.
 */
async function traceEvalRuns(
  sources: TraceEvalRunSources,
): Promise<Map<string, TraceEvalFields>> {
  const found = new Map<string, TraceEvalFields>();
  const add = ({
    traceProviderId,
    traceId,
    checkCounts,
    ...evalRun
  }: EvalTraceRun & { providerId: string }) => {
    const key = `${traceProviderId}:${traceId}`;
    const counts = checkCounts ?? found.get(key)?.checkCounts;
    found.set(key, { evalRun, ...(counts && { checkCounts: counts }) });
  };
  await Promise.all(
    Array.from(sources.providers, async provider => {
      try {
        for (const link of await provider.listTraceRuns()) {
          add({ ...link, providerId: provider.id });
        }
      } catch (error) {
        console.error(`failed to list ${provider.id}'s eval traces:`, error);
      }
    }),
  );
  for (const link of sources.runner?.traceRuns() ?? []) add(link);
  return found;
}

/**
 * `GET /api/traces` — summaries of every trace across `providers`, per
 * provider newest first. With `evals`, each trace an eval run produced
 * carries its `evalRun` and `checkCounts`.
 */
export async function handleListTraces(
  providers: Iterable<TraceProvider>,
  evals?: TraceEvalRunSources,
): Promise<HandlerResult> {
  try {
    const [results, evalRuns] = await Promise.all([
      Promise.all(Array.from(providers, p => p.getAllTraces())),
      evals ? traceEvalRuns(evals) : undefined,
    ]);
    const traces = results.flat();
    if (!evalRuns?.size) return { status: 200, body: traces };
    return {
      status: 200,
      body: traces.map(trace => ({
        ...trace,
        ...evalRuns.get(`${trace.providerId}:${trace.id}`),
      })),
    };
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/** `GET /api/traces/:providerId/:id` — a trace together with its spans. */
export async function handleGetTrace(
  provider: TraceProvider,
  traceId: string,
  resolveSpanPrompt: (span: Span) => Span,
): Promise<HandlerResult> {
  try {
    const trace = await provider.getTrace(traceId);
    if (!trace) return errorResult(404, "Trace not found");
    return {
      status: 200,
      body: { ...trace, spans: trace.spans.map(resolveSpanPrompt) },
    };
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/** `DELETE /api/traces/:providerId/:id` — a trace with its spans and annotations. */
export async function handleDeleteTrace(
  provider: TraceProvider,
  traceId: string,
): Promise<HandlerResult> {
  if (!provider.deleteTrace) {
    return errorResult(
      405,
      "This trace provider does not support deleting traces",
    );
  }
  try {
    const deleted = await provider.deleteTrace(traceId);
    return deleted
      ? { status: 204, body: undefined }
      : errorResult(404, "Trace not found");
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/**
 * `POST /api/trace-providers/:providerId/query` — body `{ sql, maxRows? }`:
 * one read-only SQL query against the provider's store, written against
 * {@link handleGetTraceQuerySchema}'s tables.
 */
export async function handleQueryTraces(
  provider: TraceProvider,
  body: unknown,
): Promise<HandlerResult> {
  const { query } = provider;
  if (!query) return QUERY_UNSUPPORTED;
  return answerQuery(body, (sql, options) =>
    query.call(provider, sql, options),
  );
}

/**
 * `GET /api/trace-providers/:providerId/schema` — `{ schema }`, the
 * annotated SQL DDL of the tables {@link handleQueryTraces} queries.
 */
export function handleGetTraceQuerySchema(
  provider: TraceProvider,
): HandlerResult {
  if (!provider.getQuerySchema) return QUERY_UNSUPPORTED;
  return { status: 200, body: { schema: provider.getQuerySchema() } };
}
