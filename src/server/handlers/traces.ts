// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral handlers for reading, querying, and deleting traces —
 * resolved providers in, {@link HandlerResult} out — shared by the
 * `/api/traces` routes and the MCP server.
 */

import {
  filterTraces,
  groupTraceSummaries,
  isEmptyTraceQuery,
  mergeTraceGroups,
  type TraceGroupQuery,
  type TraceQuery,
} from "@evalution/sdk";
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

/** Whether `filter` reads a trace's checks, which only the server knows. */
const onChecks = (filter: { column: string }) => filter.column === "checks";

/**
 * `query` as a trace provider is asked it: without the filters on checks.
 * `undefined` when that leaves nothing to ask.
 */
function providerQuery(query: TraceQuery | undefined): TraceQuery | undefined {
  if (!query) return undefined;
  const asked = {
    ...query,
    filters: query.filters?.filter(filter => !onChecks(filter)),
  };
  return isEmptyTraceQuery(asked) ? undefined : asked;
}

/**
 * The traces of `providers` that `query` matches, per provider newest first,
 * each carrying what `evals` knows of it. The query is applied again to what
 * the providers return: that covers the filters on checks, and a provider
 * that ignores its `query`.
 */
async function listTraces(
  providers: Iterable<TraceProvider>,
  evals: TraceEvalRunSources | undefined,
  query: TraceQuery | undefined,
): Promise<TraceSummary[]> {
  const asked = providerQuery(query);
  const [results, evalRuns] = await Promise.all([
    Promise.all(
      Array.from(providers, p =>
        asked ? p.getAllTraces(asked) : p.getAllTraces(),
      ),
    ),
    evals ? traceEvalRuns(evals) : undefined,
  ]);
  const traces = results.flat();
  return filterTraces(
    evalRuns?.size
      ? traces.map(trace => ({
          ...trace,
          ...evalRuns.get(`${trace.providerId}:${trace.id}`),
        }))
      : traces,
    query,
  );
}

/**
 * `GET /api/traces` — summaries of every trace across `providers`, per
 * provider newest first. With `evals`, each trace an eval run produced
 * carries its `evalRun` and `checkCounts`. With a `query`, only the traces
 * it matches.
 */
export async function handleListTraces(
  providers: Iterable<TraceProvider>,
  evals?: TraceEvalRunSources,
  query?: TraceQuery,
): Promise<HandlerResult> {
  try {
    return { status: 200, body: await listTraces(providers, evals, query) };
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/**
 * `GET /api/traces/groups` — the traces `query` matches across `providers`,
 * as the groups of the column it groups by. Each provider counts its own
 * groups, and those with the same key are added together.
 *
 * Grouping or filtering by checks is done here instead, over the listed
 * traces, since no trace provider knows a trace's checks. Only then do the
 * groups' summaries carry `checkCounts`.
 */
export async function handleListTraceGroups(
  providers: Iterable<TraceProvider>,
  evals: TraceEvalRunSources | undefined,
  query: TraceGroupQuery,
): Promise<HandlerResult> {
  const { groupBy, timeZone } = query;
  try {
    if (onChecks(groupBy) || query.filters?.some(onChecks)) {
      return {
        status: 200,
        body: groupTraceSummaries(
          await listTraces(providers, evals, query),
          groupBy,
          timeZone,
        ),
      };
    }
    const groups = await Promise.all(
      Array.from(providers, async provider =>
        provider.groupTraces
          ? provider.groupTraces(query)
          : groupTraceSummaries(
              filterTraces(await provider.getAllTraces(query), query),
              groupBy,
              timeZone,
            ),
      ),
    );
    return { status: 200, body: mergeTraceGroups(groups.flat()) };
  } catch (error: any) {
    return errorResult(500, error.message);
  }
}

/**
 * `GET /api/traces/:providerId/:id/eval-run` — the eval run that produced a
 * trace, or `null` if none did, so a trace's view needn't find it listed.
 */
export async function handleTraceEvalRun(
  evals: TraceEvalRunSources,
  traceProviderId: string,
  traceId: string,
): Promise<HandlerResult> {
  const runs = await traceEvalRuns(evals);
  return {
    status: 200,
    body: runs.get(`${traceProviderId}:${traceId}`)?.evalRun ?? null,
  };
}

/**
 * `handle`'s answer to the query `parse` reads from a request's query
 * parameters (`parseTraceQuery`, `parseTraceGroupQuery`), or a 400 saying
 * why they can't be read.
 */
export async function answerTraceQuery<Query>(
  parse: () => Query,
  handle: (query: Query) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  let query: Query;
  try {
    query = parse();
  } catch (error) {
    if (error instanceof TypeError) return errorResult(400, error.message);
    throw error;
  }
  return handle(query);
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
