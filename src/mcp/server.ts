// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The MCP server: the same API the REST routes serve, as MCP tools, so a
 * coding agent can list and run prompts, dig through traces with SQL,
 * annotate them, and build datasets. Every tool answers through the same
 * runtime-neutral handlers as the REST routes (`../server/handlers/`), built
 * from the same {@link ApiContext}; what's here is only the MCP-shaped
 * surface — tool schemas, optional provider ids, plain-JSON values in place
 * of `PropValue`s, and field names in place of field ids.
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { DatasetProvider } from "../dataset/dataset-provider.ts";
import { datasetQueryColumns } from "../dataset/dataset-query.ts";
import type {
  DatasetField,
  DatasetRow,
  DatasetSummary,
} from "../dataset/dataset-types.ts";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import type { ApiContext } from "../server/api-context.ts";
import {
  handleCreateAnnotation,
  handleDeleteAnnotation,
  handleListAnnotations,
  handleUpdateAnnotation,
} from "../server/handlers/annotations.ts";
import {
  type DatasetWithOverview,
  handleAddField,
  handleAddRows,
  handleCreateDataset,
  handleDeleteDataset,
  handleDeleteField,
  handleDeleteRows,
  handleGetDataset,
  handleListDatasets,
  handleListRows,
  handleQueryRows,
  handleRenameDataset,
  handleRenameField,
  handleUpdateRows,
} from "../server/handlers/datasets.ts";
import {
  handleExecutePrompt,
  handleGetPrompt,
  handleListPrompts,
  summarizePrompt,
} from "../server/handlers/prompts.ts";
import {
  handleGetTrace,
  handleGetTraceQuerySchema,
  handleListTraces,
  handleQueryTraces,
} from "../server/handlers/traces.ts";
import { fieldsForPrompt } from "../shared/dataset-fields.ts";
import { jsonToPropValue } from "../shared/json-prop-value.ts";
import type {
  AnnotationSource,
  ExecuteResponse,
  RunResources,
  ExecutionInput,
  NormalizedPrompt,
  Span,
  TraceSummary,
  TraceWithSpans,
} from "../shared/types.ts";
import { DEFAULT_QUERY_TIMEOUT_MS } from "../trace/db/read-only-query.ts";
import { rollupSpans } from "../trace/span-rollup.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import { registerEvalTools } from "./eval-tools.ts";
import {
  describeField,
  describeRow,
  executionInput,
  resourceInstance,
  runResources,
  findField,
  findPrompt,
  findTrace,
  guard,
  ok,
  pickProvider,
  providerIdParam,
  refOf,
  relay,
  unwrap,
} from "./tool-helpers.ts";

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  /** The version reported to clients. */
  version: string;
  /**
   * How long `execute_prompt` waits for a run to finish by default, in
   * seconds. Defaults to 300.
   */
  defaultExecuteTimeoutSeconds?: number;
  /**
   * The connected client's name, when the host knows it but this server
   * instance may not have seen the client's `initialize`: over HTTP, a
   * 2025-era client is served statelessly, by a fresh instance per request.
   * See {@link MCP_CLIENT_HEADER}.
   */
  clientName?: string;
}

/**
 * The header `evalution mcp` sends, relaying to a running server, naming the
 * client it relays for — which the server's `/mcp` endpoint passes on as
 * {@link McpServerOptions.clientName}.
 */
export const MCP_CLIENT_HEADER = "x-evalution-client";

/**
 * Cells keyed by field id, from a tool call's `values` (plain JSON, `null`
 * to clear) and `cells` (raw {@link ExecutionInput}s), both keyed by field
 * name or id.
 */
function cellsFrom(
  fields: readonly DatasetField[],
  values: Record<string, unknown> | undefined,
  cells: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [ref, value] of Object.entries(values ?? {})) {
    out[findField(fields, ref).id] =
      value === null ? null : { kind: "value", value: jsonToPropValue(value) };
  }
  for (const [ref, cell] of Object.entries(cells ?? {})) {
    out[findField(fields, ref).id] = cell;
  }
  return out;
}

/** Plain JSON values as typed-in {@link ExecutionInput}s. */
function valueInputs(values: readonly unknown[]): ExecutionInput[] {
  return values.map(value => ({
    kind: "value",
    value: jsonToPropValue(value),
  }));
}

/** What `execute_prompt` reports about a finished (or still running) run. */
function describeRun(response: ExecuteResponse, found?: TraceWithSpans) {
  const base = {
    traceId: response.traceId,
    traceProviderId: response.tracerProviderId,
    ...(response.version && { version: response.version }),
    ...(response.variation && { variation: response.variation }),
  };
  if (!found) return { ...base, status: "running" };
  const { trace, spans } = found;
  const { totalTokens, cost } = rollupSpans(spans);
  const errors = spans.filter(s => s.status === "error");
  return {
    ...base,
    status: trace.status,
    ...(trace.endTime !== undefined && {
      durationMs: trace.endTime - trace.startTime,
    }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(cost !== undefined && { cost }),
    output: runOutput(spans, response.rootSpanId),
    ...(errors.length > 0 && {
      errors: errors.map(s => ({
        spanId: s.id,
        name: s.name,
        message: s.errorMessage,
      })),
    }),
    spanCount: spans.length,
  };
}

/**
 * What a run produced: the root span's output when it recorded one, else the
 * output of the last LLM call to finish.
 */
function runOutput(spans: readonly Span[], rootSpanId: string): unknown {
  const root = spans.find(s => s.id === rootSpanId);
  if (root?.llm?.output !== undefined) return root.llm.output;
  const llm = spans
    .filter(s => s.llm?.output !== undefined)
    .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
  return llm.at(-1)?.llm?.output;
}

/**
 * Waits for a dispatched run's trace to finish recording: `settled` says the
 * run is over, but its last spans may still be on their way to the store.
 */
async function waitForTrace(
  provider: TraceProvider | undefined,
  traceId: string,
  settled: Promise<void>,
  timeoutMs: number,
): Promise<TraceWithSpans | undefined> {
  if (!provider) return undefined;
  const deadline = Date.now() + timeoutMs;
  const timedOut = await Promise.race([
    settled.then(() => false),
    new Promise<boolean>(resolve =>
      setTimeout(() => resolve(true), timeoutMs).unref?.(),
    ),
  ]);
  if (timedOut) return undefined;
  // The run is over; its trace should follow within moments.
  const pollUntil = Math.min(deadline, Date.now() + 5000);
  let trace = await provider.getTrace(traceId);
  while (
    (!trace || trace.trace.status === "running") &&
    Date.now() < pollUntil
  ) {
    await new Promise(resolve => setTimeout(resolve, 50));
    trace = await provider.getTrace(traceId);
  }
  return trace;
}

/** Who an annotation an agent writes is from, judged by the connected client's name. */
function annotationSourceFor(clientName: string | undefined): AnnotationSource {
  if (clientName && /codex/i.test(clientName)) return "codex";
  if (clientName && /claude/i.test(clientName)) return "claude-code";
  return "agent";
}

/** How long an ad-hoc SQL query may run, as the query tools describe it. */
const QUERY_TIMEOUT_SECONDS = DEFAULT_QUERY_TIMEOUT_MS / 1000;

/** A field given by hand: a primitive type, or a copy of a prompt parameter's. */
const fieldSpec = z.union([
  z.object({
    name: z.string().describe("The field's name."),
    type: z.enum(["string", "number", "boolean"]),
  }),
  z.object({
    name: z
      .string()
      .optional()
      .describe("The field's name. Defaults to the parameter's."),
    from: z
      .object({
        providerId: z.string(),
        promptId: z.string(),
        half: z
          .enum(["function", "execute"])
          .optional()
          .describe(
            "Which of the prompt's parameter lists `path` is in. Defaults to function.",
          ),
        path: z
          .string()
          .describe("The parameter's name, or a dotted path into it."),
      })
      .describe("Copy the type of this prompt parameter."),
  }),
]);

/**
 * Builds an MCP server answering from `context`. One instance serves one
 * connection (stdio) or one request (HTTP); everything it holds is in
 * `context`, so building one is cheap.
 */
export function createMcpServer(
  context: ApiContext,
  { version, defaultExecuteTimeoutSeconds = 300, clientName }: McpServerOptions,
): McpServer {
  const server = new McpServer(
    { name: "evalution", version },
    {
      instructions:
        "Evalution is a prompt playground for this project. Use list_prompts to find prompts (with their source files) and execute_prompt to run one; every run is recorded as a trace. Explore traces with list_traces, query_traces (SQL — call get_trace_schema first), and get_traces; leave findings on them with the annotation tools. Datasets hold rows of inputs for prompts; build and query them with the dataset tools. Evals run a prompt over every row of a dataset and judge each result with checks: define them with create_eval, start a run with start_eval_run, and follow it with get_eval_run, whose results point at each row's trace.",
    },
  );
  const { promptProviders, traceProviders, datasetProviders } = context;
  const datasetProvider = (id: string | undefined): DatasetProvider =>
    pickProvider(datasetProviders, id, "dataset");
  const traceProvider = (id: string | undefined): TraceProvider =>
    pickProvider(traceProviders, id, "trace");
  const fieldsOf = async (
    provider: DatasetProvider,
    datasetId: string,
  ): Promise<DatasetField[]> =>
    unwrap<DatasetWithOverview>(
      await handleGetDataset(provider, datasetId, context.resolvePromptLink),
    ).dataset.fields;

  // ── prompts ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_prompts",
    {
      title: "List prompts",
      description:
        "Lists every prompt in the project: its id, the file it's defined in, its model, the parameters it takes (with their TypeScript types), and its model parameters.",
      inputSchema: z.object({ providerId: providerIdParam("prompt") }),
      annotations: { readOnlyHint: true },
    },
    ({ providerId }) =>
      guard(async () => {
        const providers =
          providerId === undefined
            ? promptProviders
            : new Map([
                [
                  providerId,
                  pickProvider(promptProviders, providerId, "prompt"),
                ],
              ]);
        const prompts = unwrap<(NormalizedPrompt & { providerId: string })[]>(
          await handleListPrompts(providers),
        );
        return ok(
          prompts.map(prompt =>
            summarizePrompt(
              providers.get(prompt.providerId) as PromptProvider,
              prompt,
            ),
          ),
        );
      }),
  );

  server.registerTool(
    "get_prompt",
    {
      title: "Get a prompt",
      description:
        "Gets one prompt in full, as the playground sees it: its messages or questions, model, parameters, and every input source that can fill them. Values are ts-proppy PropValues.",
      inputSchema: z.object({
        promptId: z
          .string()
          .describe("The prompt's id (or globalId), from list_prompts."),
        providerId: providerIdParam("prompt"),
        version: z
          .string()
          .optional()
          .describe("A past version to read instead of head."),
        variation: z
          .string()
          .optional()
          .describe("A variation to read instead of head."),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ promptId, providerId, version, variation }) =>
      guard(async () => {
        const found = await findPrompt(context, promptId, providerId);
        return relay(
          await handleGetPrompt(
            found.provider,
            refOf(found.promptId, { version, variation }),
          ),
        );
      }),
  );

  server.registerTool(
    "execute_prompt",
    {
      title: "Run a prompt",
      description:
        "Runs a prompt with the given arguments and records the run as a trace. By default waits for the run to finish and returns its output, token usage, cost, and any errors; get_traces has every span. Pass plain JSON in `args` (positional, one per function parameter) and `executeArgs` (by name, for execute parameters); use `inputs`/`executeInputs` instead to pass unresolved inputs such as resources.",
      inputSchema: z.object({
        promptId: z
          .string()
          .describe("The prompt's id (or globalId), from list_prompts."),
        providerId: providerIdParam("prompt"),
        variation: z
          .string()
          .optional()
          .describe("Run this variation (e.g. unsaved edits) instead of head."),
        args: z
          .array(z.unknown())
          .optional()
          .describe(
            "The prompt function's arguments as plain JSON values, in order.",
          ),
        inputs: z
          .array(executionInput)
          .optional()
          .describe("The arguments as unresolved inputs, in place of `args`."),
        executeArgs: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Execute parameters (from list_prompts) as plain JSON values, by name.",
          ),
        executeInputs: z
          .record(z.string(), executionInput)
          .optional()
          .describe(
            "Execute parameters as unresolved inputs, in place of `executeArgs`.",
          ),
        resources: runResources.optional(),
        wait: z
          .boolean()
          .optional()
          .describe(
            "Wait for the run to finish (default true). When false, returns the trace id at once.",
          ),
        timeoutSeconds: z
          .number()
          .positive()
          .optional()
          .describe(
            `How long to wait for the run (default ${defaultExecuteTimeoutSeconds}). A run still going then is reported as running.`,
          ),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    args =>
      guard(async () => {
        const found = await findPrompt(context, args.promptId, args.providerId);
        const result = await handleExecutePrompt(
          context,
          found.provider,
          refOf(found.promptId, { variation: args.variation }),
          {
            functionInputs:
              (args.inputs as ExecutionInput[] | undefined) ??
              valueInputs(args.args ?? []),
            executeInputs:
              (args.executeInputs as
                | Record<string, ExecutionInput>
                | undefined) ??
              Object.fromEntries(
                Object.entries(args.executeArgs ?? {}).map(([name, value]) => [
                  name,
                  valueInputs([value])[0],
                ]),
              ),
            ...(args.resources && {
              resources: args.resources as RunResources,
            }),
          },
        );
        const response = unwrap<ExecuteResponse>(result);
        if (args.wait === false || !result.settled) {
          return ok(describeRun(response));
        }
        const trace = await waitForTrace(
          traceProviders.get(response.tracerProviderId),
          response.traceId,
          result.settled,
          (args.timeoutSeconds ?? defaultExecuteTimeoutSeconds) * 1000,
        );
        return ok(describeRun(response, trace));
      }),
  );

  // ── traces ───────────────────────────────────────────────────────────

  server.registerTool(
    "list_traces",
    {
      title: "List traces",
      description:
        "Lists recorded traces (prompt runs and traces exported to evalution), newest first, with status, span count, tokens, cost, model, and annotation counts. For anything more specific, use query_traces.",
      inputSchema: z.object({
        providerId: providerIdParam("trace"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("The most traces to return (default 50)."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("How many traces to skip."),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ providerId, limit = 50, offset = 0 }) =>
      guard(async () => {
        const providers =
          providerId === undefined
            ? traceProviders.values()
            : [traceProvider(providerId)];
        const traces = unwrap<TraceSummary[]>(
          await handleListTraces(providers, {
            providers: context.evalProviders.values(),
            runner: context.evalRunner,
          }),
        ).sort((a, b) => b.startTime - a.startTime);
        return ok({
          total: traces.length,
          traces: traces.slice(offset, offset + limit),
        });
      }),
  );

  server.registerTool(
    "get_trace_schema",
    {
      title: "Get the trace database schema",
      description:
        "Returns the SQL schema (annotated CREATE TABLE statements for traces, spans, and annotations) that query_traces runs against.",
      inputSchema: z.object({ providerId: providerIdParam("trace") }),
      annotations: { readOnlyHint: true },
    },
    ({ providerId }) =>
      guard(async () => {
        const result = handleGetTraceQuerySchema(traceProvider(providerId));
        return ok(unwrap<{ schema: string }>(result).schema);
      }),
  );

  server.registerTool(
    "query_traces",
    {
      title: "Query traces with SQL",
      description: `Runs one read-only SQL query (SQLite dialect; a SELECT or WITH … SELECT) against the trace database's traces, spans, and annotations tables, and returns the rows. Call get_trace_schema for the tables and columns. JSON columns can be read with json_extract(). A query that runs longer than ${QUERY_TIMEOUT_SECONDS} seconds is stopped with an error, so filter before joining large tables.`,
      inputSchema: z.object({
        sql: z.string().describe("The query."),
        providerId: providerIdParam("trace"),
        maxRows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("The most rows to return (default 1000)."),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ sql, providerId, maxRows }) =>
      guard(async () =>
        relay(
          await handleQueryTraces(traceProvider(providerId), {
            sql,
            ...(maxRows && { maxRows }),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_traces",
    {
      title: "Get traces",
      description:
        "Gets one or more traces in full: every span (inputs, outputs, model, tokens, cost, tool calls, errors, timing) and every annotation.",
      inputSchema: z.object({
        traceIds: z.array(z.string()).min(1).describe("The traces' ids."),
        providerId: providerIdParam("trace"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ traceIds, providerId }) =>
      guard(async () => {
        const traces = await Promise.all(
          traceIds.map(async traceId => {
            try {
              const provider = await findTrace(context, traceId, providerId);
              const trace = unwrap<TraceWithSpans>(
                await handleGetTrace(
                  provider,
                  traceId,
                  context.resolveSpanPrompt,
                ),
              );
              const annotations = provider.listAnnotations
                ? unwrap<unknown[]>(
                    await handleListAnnotations(provider, traceId),
                  )
                : [];
              return { ...trace, providerId: provider.id, annotations };
            } catch (err) {
              return {
                id: traceId,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );
        return ok(traces);
      }),
  );

  // ── annotations ──────────────────────────────────────────────────────

  const traceIdParam = z.string().describe("The trace's id.");
  const annotationKind = z
    .enum(["issue", "good", "note"])
    .describe(
      "issue: something went wrong; good: something worth keeping; note: anything else.",
    );

  server.registerTool(
    "list_annotations",
    {
      title: "List annotations",
      description: "Lists the annotations on a trace, oldest first.",
      inputSchema: z.object({
        traceId: traceIdParam,
        providerId: providerIdParam("trace"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ traceId, providerId }) =>
      guard(async () =>
        relay(
          await handleListAnnotations(
            await findTrace(context, traceId, providerId),
            traceId,
          ),
        ),
      ),
  );

  server.registerTool(
    "create_annotation",
    {
      title: "Annotate a trace",
      description:
        "Leaves a note on a trace, or on one span of it. It shows up live in the evalution UI.",
      inputSchema: z.object({
        traceId: traceIdParam,
        spanId: z
          .string()
          .optional()
          .describe("The span to attach it to. Omit for the whole trace."),
        kind: annotationKind,
        note: z.string().min(1).describe("The note."),
        providerId: providerIdParam("trace"),
      }),
    },
    ({ traceId, spanId, kind, note, providerId }) =>
      guard(async () =>
        relay(
          await handleCreateAnnotation(
            await findTrace(context, traceId, providerId),
            traceId,
            {
              kind,
              note,
              ...(spanId && { spanId }),
              source: annotationSourceFor(
                server.server.getClientVersion()?.name ?? clientName,
              ),
            },
          ),
        ),
      ),
  );

  server.registerTool(
    "update_annotation",
    {
      title: "Edit an annotation",
      description: "Changes an annotation's kind and/or note.",
      inputSchema: z.object({
        traceId: traceIdParam,
        annotationId: z.string(),
        kind: annotationKind.optional(),
        note: z.string().min(1).optional(),
        providerId: providerIdParam("trace"),
      }),
      annotations: { idempotentHint: true },
    },
    ({ traceId, annotationId, kind, note, providerId }) =>
      guard(async () =>
        relay(
          await handleUpdateAnnotation(
            await findTrace(context, traceId, providerId),
            traceId,
            annotationId,
            {
              ...(kind !== undefined && { kind }),
              ...(note !== undefined && { note }),
            },
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_annotation",
    {
      title: "Delete an annotation",
      description: "Deletes an annotation from a trace.",
      inputSchema: z.object({
        traceId: traceIdParam,
        annotationId: z.string(),
        providerId: providerIdParam("trace"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ traceId, annotationId, providerId }) =>
      guard(async () =>
        relay(
          await handleDeleteAnnotation(
            await findTrace(context, traceId, providerId),
            traceId,
            annotationId,
          ),
          { deleted: annotationId },
        ),
      ),
  );

  // ── datasets ─────────────────────────────────────────────────────────

  const datasetIdParam = z.string().describe("The dataset's id.");
  const fieldRef = z
    .string()
    .describe("The field's name, or its id when several share a name.");

  server.registerTool(
    "list_datasets",
    {
      title: "List datasets",
      description:
        "Lists every dataset — named, typed collections of input rows for prompts — with its fields and row count.",
      inputSchema: z.object({ providerId: providerIdParam("dataset") }),
      annotations: { readOnlyHint: true },
    },
    ({ providerId }) =>
      guard(async () => {
        const providers =
          providerId === undefined
            ? datasetProviders.values()
            : [datasetProvider(providerId)];
        const datasets = unwrap<DatasetSummary[]>(
          await handleListDatasets(providers, context.resolvePromptLink),
        );
        return ok(
          datasets.map(({ fields, ...summary }) => ({
            ...summary,
            fields: fields.map(describeField),
          })),
        );
      }),
  );

  server.registerTool(
    "get_dataset",
    {
      title: "Get a dataset",
      description:
        "Gets a dataset's fields, row count, and the columns of the `rows` view query_dataset_rows runs against.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        providerId: providerIdParam("dataset"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ datasetId, providerId }) =>
      guard(async () => {
        const { dataset, rowCount } = unwrap<DatasetWithOverview>(
          await handleGetDataset(
            datasetProvider(providerId),
            datasetId,
            context.resolvePromptLink,
          ),
        );
        return ok({
          ...dataset,
          fields: dataset.fields.map(describeField),
          rowCount,
          queryColumns: datasetQueryColumns(dataset.fields).map(
            ({ column, description }) => ({ column, description }),
          ),
        });
      }),
  );

  server.registerTool(
    "create_dataset",
    {
      title: "Create a dataset",
      description:
        "Creates a dataset. Pass `fromPrompt` to link it to a prompt and add a field for each parameter of that prompt, and/or give it fields by hand (`fields`).",
      inputSchema: z.object({
        name: z.string().min(1),
        fields: z.array(fieldSpec).optional(),
        fromPrompt: z
          .object({
            promptId: z.string(),
            providerId: z.string().optional(),
          })
          .optional()
          .describe(
            "A prompt whose parameters become the dataset's first fields.",
          ),
        providerId: providerIdParam("dataset"),
      }),
    },
    ({ name, fields = [], fromPrompt, providerId }) =>
      guard(async () => {
        let promptFields: { def: unknown }[] = [];
        let prompt: { id: string; providerId: string } | undefined;
        if (fromPrompt) {
          const found = await findPrompt(
            context,
            fromPrompt.promptId,
            fromPrompt.providerId,
          );
          const source = unwrap<NormalizedPrompt>(
            await handleGetPrompt(found.provider, { promptId: found.promptId }),
          );
          promptFields = fieldsForPrompt(source);
          // The prompt's globalId when it has one, so the link survives moves.
          prompt = {
            id: source.globalId ?? source.id,
            providerId: found.provider.id,
          };
        }
        return relay(
          await handleCreateDataset(
            datasetProvider(providerId),
            { name, fields: [...promptFields, ...fields], prompt },
            context.resolvePromptLink,
            context.lookupFieldSourcePrompt,
          ),
        );
      }),
  );

  server.registerTool(
    "rename_dataset",
    {
      title: "Rename a dataset",
      description: "Renames a dataset. Its id doesn't change.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        name: z.string().min(1),
        providerId: providerIdParam("dataset"),
      }),
      annotations: { idempotentHint: true },
    },
    ({ datasetId, name, providerId }) =>
      guard(async () =>
        relay(
          await handleRenameDataset(
            datasetProvider(providerId),
            datasetId,
            { name },
            context.resolvePromptLink,
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_dataset",
    {
      title: "Delete a dataset",
      description: "Deletes a dataset and all of its rows.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        providerId: providerIdParam("dataset"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ datasetId, providerId }) =>
      guard(async () =>
        relay(
          await handleDeleteDataset(datasetProvider(providerId), datasetId),
          { deleted: datasetId },
        ),
      ),
  );

  server.registerTool(
    "add_field",
    {
      title: "Add a field",
      description:
        "Adds a field to a dataset: a string, number, or boolean, or a copy of a prompt parameter's type. Existing rows leave it empty.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        field: fieldSpec,
        providerId: providerIdParam("dataset"),
      }),
    },
    ({ datasetId, field, providerId }) =>
      guard(async () =>
        relay(
          await handleAddField(
            datasetProvider(providerId),
            datasetId,
            field,
            context.lookupFieldSourcePrompt,
            context.lookupFieldSourceCheck,
          ),
        ),
      ),
  );

  server.registerTool(
    "rename_field",
    {
      title: "Rename a field",
      description: "Renames a dataset field. Rows keep their values.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        field: fieldRef,
        name: z.string().min(1).describe("The new name."),
        providerId: providerIdParam("dataset"),
      }),
      annotations: { idempotentHint: true },
    },
    ({ datasetId, field, name, providerId }) =>
      guard(async () => {
        const provider = datasetProvider(providerId);
        const target = findField(await fieldsOf(provider, datasetId), field);
        return relay(
          await handleRenameField(provider, datasetId, target.id, { name }),
        );
      }),
  );

  server.registerTool(
    "delete_field",
    {
      title: "Delete a field",
      description: "Deletes a dataset field and every row's value for it.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        field: fieldRef,
        providerId: providerIdParam("dataset"),
      }),
      annotations: { destructiveHint: true },
    },
    ({ datasetId, field, providerId }) =>
      guard(async () => {
        const provider = datasetProvider(providerId);
        const target = findField(await fieldsOf(provider, datasetId), field);
        return relay(await handleDeleteField(provider, datasetId, target.id), {
          deleted: describeField(target),
        });
      }),
  );

  const cellMaps = {
    values: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Field name → plain JSON value."),
    cells: z
      .record(z.string(), executionInput)
      .optional()
      .describe(
        "Field name → an unresolved input, for a value plain JSON can't express (e.g. a resource instance).",
      ),
    resources: z
      .record(z.string(), resourceInstance.nullable())
      .optional()
      .describe(
        "The row's own resource instances, which its cells (and an eval's bindings) can name. On update, an instance set to null is removed and those left out are untouched.",
      ),
  };

  server.registerTool(
    "add_rows",
    {
      title: "Add rows",
      description:
        "Adds rows to a dataset, all or none. Each row gives a value per field by field name; fields left out stay empty.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        rows: z.array(z.object(cellMaps)).min(1),
        providerId: providerIdParam("dataset"),
      }),
    },
    ({ datasetId, rows, providerId }) =>
      guard(async () => {
        const provider = datasetProvider(providerId);
        const fields = await fieldsOf(provider, datasetId);
        const added = unwrap<DatasetRow[]>(
          await handleAddRows(provider, datasetId, {
            rows: rows.map(row => ({
              cells: cellsFrom(fields, row.values, row.cells),
              ...(row.resources && { resources: row.resources }),
            })),
          }),
        );
        return ok({ added: added.length, rowIds: added.map(r => r.id) });
      }),
  );

  server.registerTool(
    "update_rows",
    {
      title: "Update rows",
      description:
        "Sets or clears values on dataset rows, all or none. A null value clears that field; fields left out are untouched.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        updates: z.array(z.object({ rowId: z.string(), ...cellMaps })).min(1),
        providerId: providerIdParam("dataset"),
      }),
      annotations: { idempotentHint: true },
    },
    ({ datasetId, updates, providerId }) =>
      guard(async () => {
        const provider = datasetProvider(providerId);
        const fields = await fieldsOf(provider, datasetId);
        return relay(
          await handleUpdateRows(provider, datasetId, {
            updates: updates.map(update => ({
              rowId: update.rowId,
              cells: cellsFrom(fields, update.values, update.cells),
              ...(update.resources && { resources: update.resources }),
            })),
          }),
          { updated: updates.length },
        );
      }),
  );

  server.registerTool(
    "delete_rows",
    {
      title: "Delete rows",
      description:
        "Deletes rows from a dataset, all at once: if it fails, no row is deleted. Ids of rows that don't exist are skipped; the result says how many were deleted.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        rowIds: z.array(z.string()).min(1),
        providerId: providerIdParam("dataset"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ datasetId, rowIds, providerId }) =>
      guard(async () =>
        relay(
          await handleDeleteRows(
            datasetProvider(providerId),
            datasetId,
            rowIds,
          ),
        ),
      ),
  );

  server.registerTool(
    "list_dataset_rows",
    {
      title: "List dataset rows",
      description:
        "Lists a page of a dataset's rows, oldest first, with values keyed by field name. For filtering, sorting, or aggregating, use query_dataset_rows.",
      inputSchema: z.object({
        datasetId: datasetIdParam,
        offset: z.number().int().nonnegative().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("The most rows to return (default and maximum 1000)."),
        providerId: providerIdParam("dataset"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ datasetId, offset, limit, providerId }) =>
      guard(async () => {
        const provider = datasetProvider(providerId);
        const fields = await fieldsOf(provider, datasetId);
        const rows = unwrap<DatasetRow[]>(
          await handleListRows(provider, datasetId, {
            ...(offset !== undefined && { offset: String(offset) }),
            ...(limit !== undefined && { limit: String(limit) }),
          }),
        );
        return ok(rows.map(row => describeRow(row, fields)));
      }),
  );

  server.registerTool(
    "query_dataset_rows",
    {
      title: "Query dataset rows with SQL",
      description: `Runs one read-only SQL query (SQLite dialect) against a \`rows\` view of a dataset: one column per field, named after it, plus _id, _created_at, _source, and _cells. A typed-in string, number, or boolean reads as its plain value; anything else reads as JSON. get_dataset lists the columns. Example: SELECT city, count(*) FROM rows GROUP BY city. A query that runs longer than ${QUERY_TIMEOUT_SECONDS} seconds is stopped with an error.`,
      inputSchema: z.object({
        datasetId: datasetIdParam,
        sql: z.string().describe("The query."),
        maxRows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("The most rows to return (default 1000)."),
        providerId: providerIdParam("dataset"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ datasetId, sql, maxRows, providerId }) =>
      guard(async () =>
        relay(
          await handleQueryRows(datasetProvider(providerId), datasetId, {
            sql,
            ...(maxRows && { maxRows }),
          }),
        ),
      ),
  );

  registerEvalTools(server, context);

  // ── resources ────────────────────────────────────────────────────────

  for (const [id, provider] of traceProviders) {
    if (!provider.getQuerySchema) continue;
    const uri = `evalution://trace-providers/${encodeURIComponent(id)}/schema`;
    server.registerResource(
      `trace-schema-${id}`,
      uri,
      {
        title: `Trace database schema (${provider.displayName ?? id})`,
        description:
          "The SQL schema query_traces runs against: annotated CREATE TABLE statements.",
        mimeType: "application/sql",
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: "application/sql",
            text: unwrap<{ schema: string }>(
              handleGetTraceQuerySchema(provider),
            ).schema,
          },
        ],
      }),
    );
  }

  return server;
}
