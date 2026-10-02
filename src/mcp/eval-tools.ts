// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The MCP server's eval tools: CRUD for evals, starting runs without waiting
 * for them, and reading a run's status and results. Every tool answers
 * through the same handlers as the `/api/evals` routes
 * (`../server/handlers/evals.ts`); what's here is the MCP-shaped surface —
 * bindings that name dataset columns by field name and carry plain JSON, the
 * editor's automatic column matching, and results summarized per arm with a
 * pointer to each row's trace.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { DatasetField } from "../dataset/dataset-types.ts";
import type { EvalProvider } from "../eval/eval-provider.ts";
import type {
  EvalCheck,
  EvalCheckResult,
  EvalDefinition,
  EvalInputs,
  EvalRun,
  EvalRunSummary,
  EvalSummary,
} from "../eval/eval-types.ts";
import { summarizeArm } from "../eval/run-summary.ts";
import type { ApiContext } from "../server/api-context.ts";
import {
  type EvalRunWithResults,
  evalRunnerOrRefusal,
  handleCancelRun,
  handleCreateEval,
  handleDeleteEval,
  handleDeleteRun,
  handleGetEval,
  handleGetRun,
  handleListEvals,
  handleListRuns,
  handleStartRun,
  handleUpdateEval,
} from "../server/handlers/evals.ts";
import { summarizeParameter } from "../server/handlers/prompts.ts";
import { prefillBindings } from "../shared/eval-prefill.ts";
import { evalProblems } from "../shared/eval-problems.ts";
import { jsonToPropValue, propValueToJson } from "../shared/json-prop-value.ts";
import type {
  CheckInfo,
  ExecutionInput,
  NormalizedPrompt,
  PromptID,
} from "../shared/types.ts";
import {
  describeCells,
  describeField,
  findField,
  findPrompt,
  guard,
  ok,
  pickProvider,
  providerIdParam,
  relay,
  ToolError,
  unwrap,
} from "./tool-helpers.ts";

/** What an eval tool may find of an eval's prompt, dataset, and checks. */
interface EvalSetting {
  prompt?: NormalizedPrompt;
  /** The prompt provider's id, when the prompt resolves. */
  promptProviderId?: string;
  fields?: DatasetField[];
  checkInfos?: CheckInfo[];
}

/**
 * A binding as a tool takes it, turned into the {@link ExecutionInput} an
 * eval stores. On top of the stored shapes, `{ column }` names a dataset
 * column by field name (or id) and `{ json }` is a plain JSON value; a
 * stored `{ kind: "dataset", field }` may name its field by name too. Applies
 * at any depth.
 */
function bindingFrom(
  value: unknown,
  fields: readonly DatasetField[] | undefined,
  path: string,
): ExecutionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError(
      `${path} must be a binding: {column}, {json}, or an input with a kind`,
    );
  }
  const binding = value as Record<string, unknown>;
  const column = (ref: unknown): ExecutionInput => {
    if (typeof ref !== "string") {
      throw new ToolError(`${path}: a column must be a field name or id`);
    }
    if (!fields) {
      throw new ToolError(`${path}: the eval's dataset doesn't exist`);
    }
    return { kind: "dataset", field: findField(fields, ref).id };
  };
  if ("column" in binding) return column(binding.column);
  if ("json" in binding) {
    return { kind: "value", value: jsonToPropValue(binding.json) };
  }
  switch (binding.kind) {
    case "dataset":
      return column(binding.field);
    case "object": {
      const properties = binding.properties;
      if (typeof properties !== "object" || properties === null) {
        throw new ToolError(`${path}.properties must be an object`);
      }
      return {
        kind: "object",
        properties: Object.fromEntries(
          Object.entries(properties).map(([k, v]) => [
            k,
            bindingFrom(v, fields, `${path}.properties.${k}`),
          ]),
        ),
      };
    }
    case "resource": {
      const args = binding.args as Record<string, unknown> | undefined;
      return {
        ...(binding as ExecutionInput & { kind: "resource" }),
        ...(args && {
          args: Object.fromEntries(
            Object.entries(args).map(([k, v]) => [
              k,
              bindingFrom(v, fields, `${path}.args.${k}`),
            ]),
          ),
        }),
      };
    }
    default:
      // A typed-in value or a slot reference: checked when it's saved.
      return binding as ExecutionInput;
  }
}

/** A stored binding as a tool shows it — the inverse of {@link bindingFrom}. */
function describeBinding(
  input: ExecutionInput,
  fields: readonly DatasetField[] | undefined,
): unknown {
  switch (input.kind) {
    case "dataset": {
      const field = fields?.find(f => f.id === input.field);
      return field ? { column: field.def.name } : input;
    }
    case "value": {
      const plain = propValueToJson(input.value);
      return plain === undefined ? input : { json: plain };
    }
    case "object":
      return {
        kind: "object",
        properties: describeBindings(input.properties, fields),
      };
    case "resource":
      return input.args
        ? { ...input, args: describeBindings(input.args, fields) }
        : input;
    default:
      return input;
  }
}

function describeBindings(
  bindings: Record<string, ExecutionInput>,
  fields: readonly DatasetField[] | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(bindings).map(([k, v]) => [k, describeBinding(v, fields)]),
  );
}

/** A check id for `uri`, unique among `taken`: its export name, numbered on repeats. */
function checkIdFor(uri: string, taken: Set<string>): string {
  const base =
    (uri.split("#").at(-1) ?? "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "check";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

const binding = z
  .record(z.string(), z.unknown())
  .describe(
    'How to fill a slot: {column: "<dataset field name>"} for the row\'s value, {json: <plain JSON>} for a fixed value, {kind: "input", half: "function" | "execute", path} for what the run bound to one of the prompt\'s own slots, {kind: "object", properties: {name: binding}} to fill an object property by property, or {kind: "resource", uri, args?: {name: binding}}.',
  );

const bindings = z
  .record(z.string(), binding)
  .describe("Parameter name → binding.");

const checkSpec = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Stable within the eval; results are keyed by it. Defaults to the check's export name.",
    ),
  uri: z.string().describe("The check's uri, from list_checks."),
  label: z.string().optional().describe("Overrides the check's own label."),
  args: bindings
    .optional()
    .describe(
      "Check parameter name → binding. Parameters left out are matched to a column or prompt slot of the same name and type, when autoBind is on.",
    ),
  threshold: z
    .number()
    .optional()
    .describe(
      "For a check that returns a score: at or above this passes. Without one, the score is reported on its own.",
    ),
});

const armSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("head") }),
  z.object({
    kind: z.literal("variation"),
    variation: z.string().describe("The variation's id."),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("wip"),
    variation: z
      .string()
      .describe("The id of the variation holding the unsaved edits."),
  }),
]);

const evalIdParam = z.string().describe("The eval's id, from list_evals.");
const runIdParam = z
  .string()
  .describe("The run's id, from start_eval_run or list_eval_runs.");

const autoBindParam = z
  .boolean()
  .optional()
  .describe(
    "Bind every slot and check parameter left unbound to a dataset column with the same name and type, as the eval editor does (default true). Bindings given are never overwritten.",
  );

/** Registers the eval tools on `server`, answering from `context`. */
export function registerEvalTools(
  server: McpServer,
  context: ApiContext,
): void {
  const { evalProviders, datasetProviders } = context;
  const evalProvider = (id: string | undefined): EvalProvider =>
    pickProvider(evalProviders, id, "eval");

  /** Whatever of the eval's prompt, dataset, and checks still exists. */
  const settingOf = async (
    def: Pick<EvalDefinition, "prompt" | "dataset">,
  ): Promise<EvalSetting> => {
    const target = context.promptRegistry.resolve(
      def.prompt.id,
      def.prompt.providerId,
    );
    const promptProvider =
      target && context.promptProviders.get(target.providerId);
    const prompt =
      target &&
      (await promptProvider?.getPrompt({ promptId: target.promptId }));
    const dataset = await datasetProviders
      .get(def.dataset.providerId)
      ?.getDataset(def.dataset.id);
    const checkInfos =
      target && (await context.listChecksOf(target.providerId));
    return {
      ...(prompt && { prompt, promptProviderId: target?.providerId }),
      ...(dataset && { fields: dataset.fields }),
      ...(checkInfos && { checkInfos }),
    };
  };

  /** The eval as a tool shows it, with what stops it from running. */
  const describeEval = (
    def: EvalDefinition,
    providerId: string,
    setting: EvalSetting,
  ) => {
    const { prompt, fields, checkInfos } = setting;
    const problems = [
      ...(prompt ? [] : ["The eval's prompt doesn't exist"]),
      ...(fields ? [] : ["The eval's dataset doesn't exist"]),
      ...evalProblems(def.inputs, def.checks, {
        ...(prompt && { prompt }),
        ...(fields && { fields }),
        ...(checkInfos && { checks: checkInfos }),
      }),
    ];
    return {
      providerId,
      id: def.id,
      name: def.name,
      prompt: {
        ...def.prompt,
        ...(prompt && {
          promptId: prompt.id,
          providerId: setting.promptProviderId,
        }),
      },
      dataset: def.dataset,
      ...(fields && { datasetFields: fields.map(describeField) }),
      inputs: {
        functionInputs: describeBindings(def.inputs.functionInputs, fields),
        executeInputs: describeBindings(def.inputs.executeInputs, fields),
      },
      checks: def.checks.map(check => ({
        id: check.id,
        uri: check.uri,
        ...(check.label && { label: check.label }),
        args: describeBindings(check.args, fields),
        ...(check.threshold !== undefined && { threshold: check.threshold }),
      })),
      problems,
      createdAt: def.createdAt,
      updatedAt: def.updatedAt,
    };
  };

  /** `half`'s bindings from a tool call, by parameter name; `null` unbinds. */
  const bindingsFrom = (
    given: Record<string, unknown> | undefined,
    current: Record<string, ExecutionInput>,
    fields: readonly DatasetField[] | undefined,
    path: string,
  ): Record<string, ExecutionInput> => {
    const out = { ...current };
    for (const [name, value] of Object.entries(given ?? {})) {
      if (value === null) delete out[name];
      else out[name] = bindingFrom(value, fields, `${path}.${name}`);
    }
    return out;
  };

  const checksFrom = (
    given: z.infer<typeof checkSpec>[],
    fields: readonly DatasetField[] | undefined,
  ): EvalCheck[] => {
    const taken = new Set(given.flatMap(c => (c.id ? [c.id] : [])));
    return given.map((check, i) => ({
      id: check.id ?? checkIdFor(check.uri, taken),
      uri: check.uri,
      ...(check.label && { label: check.label }),
      args: bindingsFrom(check.args, {}, fields, `checks[${i}].args`),
      ...(check.threshold !== undefined && { threshold: check.threshold }),
    }));
  };

  /** `inputs` and `checks` with the editor's proposals filled in. */
  const autoBound = (
    setting: EvalSetting,
    inputs: EvalInputs,
    checks: EvalCheck[],
  ): { inputs: EvalInputs; checks: EvalCheck[] } => {
    if (!setting.prompt || !setting.fields) return { inputs, checks };
    const proposed = prefillBindings({
      prompt: setting.prompt,
      fields: setting.fields,
      inputs,
      checks,
      checkInfos: setting.checkInfos ?? [],
    });
    return { inputs: proposed.inputs, checks: proposed.checks };
  };

  /** The prompt an eval should name: its globalId when it has one, so moves don't orphan it. */
  const promptIdOf = async (
    promptId: string,
    providerId: string | undefined,
  ): Promise<PromptID> => {
    const found = await findPrompt(context, promptId, providerId);
    const prompt = await found.provider.getPrompt({
      promptId: found.promptId,
    });
    if (!prompt) throw new ToolError(`Prompt not found: ${promptId}`);
    return { id: prompt.globalId ?? prompt.id, providerId: found.provider.id };
  };

  const datasetOf = (
    datasetId: string,
    providerId: string | undefined,
  ): { providerId: string; id: string } => ({
    providerId: pickProvider(datasetProviders, providerId, "dataset").id,
    id: datasetId,
  });

  // ── evals ────────────────────────────────────────────────────────────

  server.registerTool(
    "list_checks",
    {
      title: "List checks",
      description:
        "Lists the checks an eval can run on each result: the project's own (made with check()) and the built-ins, with the parameters each takes.",
      inputSchema: z.object({ promptProviderId: providerIdParam("prompt") }),
      annotations: { readOnlyHint: true },
    },
    ({ promptProviderId }) =>
      guard(async () => {
        const { id } = pickProvider(
          context.promptProviders,
          promptProviderId,
          "prompt",
        );
        const checks = (await context.listChecksOf(id)) ?? [];
        return ok(
          checks.map(({ parameters, ...check }) => ({
            ...check,
            parameters: parameters.map(summarizeParameter),
          })),
        );
      }),
  );

  server.registerTool(
    "list_evals",
    {
      title: "List evals",
      description:
        "Lists every eval — a prompt run over each row of a dataset, with checks judging each result — most recently updated first, with its last run's status and counts.",
      inputSchema: z.object({ providerId: providerIdParam("eval") }),
      annotations: { readOnlyHint: true },
    },
    ({ providerId }) =>
      guard(async () => {
        const providers =
          providerId === undefined
            ? evalProviders.values()
            : [evalProvider(providerId)];
        return ok(unwrap<EvalSummary[]>(await handleListEvals(providers)));
      }),
  );

  server.registerTool(
    "get_eval",
    {
      title: "Get an eval",
      description:
        "Gets an eval's definition: its prompt, dataset (with its fields), how each prompt parameter and check parameter is bound, and `problems` — what would stop it from running, empty when it can run.",
      inputSchema: z.object({
        evalId: evalIdParam,
        providerId: providerIdParam("eval"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ evalId, providerId }) =>
      guard(async () => {
        const provider = evalProvider(providerId);
        const def = unwrap<EvalDefinition>(
          await handleGetEval(provider, evalId),
        );
        return ok(describeEval(def, provider.id, await settingOf(def)));
      }),
  );

  server.registerTool(
    "create_eval",
    {
      title: "Create an eval",
      description:
        "Creates an eval: a prompt to run over every row of a dataset, how to fill the prompt's parameters from each row, and checks that judge each result (see list_checks). By default, parameters are bound to the dataset columns that match them by name and type, as the eval editor does. Returns the eval with `problems` — what's left to bind before it can run.",
      inputSchema: z.object({
        name: z.string().min(1),
        promptId: z
          .string()
          .describe("The prompt's id (or globalId), from list_prompts."),
        promptProviderId: providerIdParam("prompt"),
        datasetId: z.string().describe("The dataset's id, from list_datasets."),
        datasetProviderId: providerIdParam("dataset"),
        functionInputs: bindings
          .optional()
          .describe("Function parameter name → binding."),
        executeInputs: bindings
          .optional()
          .describe("Execute parameter name → binding."),
        checks: z.array(checkSpec).optional(),
        autoBind: autoBindParam,
        providerId: providerIdParam("eval"),
      }),
    },
    args =>
      guard(async () => {
        const provider = evalProvider(args.providerId);
        const prompt = await promptIdOf(args.promptId, args.promptProviderId);
        const dataset = datasetOf(args.datasetId, args.datasetProviderId);
        const setting = await settingOf({ prompt, dataset });
        if (!setting.fields) {
          throw new ToolError(`Dataset not found: ${args.datasetId}`);
        }
        let inputs: EvalInputs = {
          functionInputs: bindingsFrom(
            args.functionInputs,
            {},
            setting.fields,
            "functionInputs",
          ),
          executeInputs: bindingsFrom(
            args.executeInputs,
            {},
            setting.fields,
            "executeInputs",
          ),
        };
        let checks = checksFrom(args.checks ?? [], setting.fields);
        if (args.autoBind !== false) {
          ({ inputs, checks } = autoBound(setting, inputs, checks));
        }
        const created = unwrap<EvalDefinition>(
          await handleCreateEval(provider, {
            name: args.name,
            prompt,
            dataset,
            inputs,
            checks,
          }),
        );
        return ok(describeEval(created, provider.id, setting));
      }),
  );

  server.registerTool(
    "update_eval",
    {
      title: "Change an eval",
      description:
        "Changes an eval. Bindings given replace those parameters' bindings (null unbinds one) and leave the rest; `checks`, when given, replaces the whole list — get_eval shows it in the shape this takes. Runs keep the definition they ran with. Returns the eval with its `problems`.",
      inputSchema: z.object({
        evalId: evalIdParam,
        name: z.string().min(1).optional(),
        promptId: z.string().optional().describe("Run a different prompt."),
        promptProviderId: providerIdParam("prompt"),
        datasetId: z.string().optional().describe("Run a different dataset."),
        datasetProviderId: providerIdParam("dataset"),
        functionInputs: z
          .record(z.string(), binding.nullable())
          .optional()
          .describe("Function parameter name → binding, or null to unbind."),
        executeInputs: z
          .record(z.string(), binding.nullable())
          .optional()
          .describe("Execute parameter name → binding, or null to unbind."),
        checks: z.array(checkSpec).optional(),
        autoBind: autoBindParam,
        providerId: providerIdParam("eval"),
      }),
      annotations: { idempotentHint: true },
    },
    args =>
      guard(async () => {
        const provider = evalProvider(args.providerId);
        const current = unwrap<EvalDefinition>(
          await handleGetEval(provider, args.evalId),
        );
        const prompt =
          args.promptId === undefined
            ? current.prompt
            : await promptIdOf(args.promptId, args.promptProviderId);
        const dataset =
          args.datasetId === undefined
            ? current.dataset
            : datasetOf(args.datasetId, args.datasetProviderId);
        const setting = await settingOf({ prompt, dataset });
        let inputs: EvalInputs = {
          functionInputs: bindingsFrom(
            args.functionInputs,
            current.inputs.functionInputs,
            setting.fields,
            "functionInputs",
          ),
          executeInputs: bindingsFrom(
            args.executeInputs,
            current.inputs.executeInputs,
            setting.fields,
            "executeInputs",
          ),
        };
        let checks = args.checks
          ? checksFrom(args.checks, setting.fields)
          : current.checks;
        if (args.autoBind !== false) {
          ({ inputs, checks } = autoBound(setting, inputs, checks));
        }
        const updated = unwrap<EvalDefinition>(
          await handleUpdateEval(provider, args.evalId, {
            ...(args.name !== undefined && { name: args.name }),
            prompt,
            dataset,
            inputs,
            checks,
          }),
        );
        return ok(describeEval(updated, provider.id, setting));
      }),
  );

  server.registerTool(
    "delete_eval",
    {
      title: "Delete an eval",
      description: "Deletes an eval with all of its runs and their results.",
      inputSchema: z.object({
        evalId: evalIdParam,
        providerId: providerIdParam("eval"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ evalId, providerId }) =>
      guard(async () =>
        relay(await handleDeleteEval(evalProvider(providerId), evalId), {
          deleted: evalId,
        }),
      ),
  );

  // ── runs ─────────────────────────────────────────────────────────────

  server.registerTool(
    "start_eval_run",
    {
      title: "Start an eval run",
      description:
        "Starts a run of an eval: the prompt runs on every dataset row, each run recorded as a trace, and the checks judge each result. Returns at once, without waiting for the run; poll get_eval_run for its progress and results. Refused, with the reasons, when the eval has problems (see get_eval).",
      inputSchema: z.object({
        evalId: evalIdParam,
        arms: z
          .array(armSpec)
          .min(1)
          .optional()
          .describe(
            'The prompt variants to compare, each run on every row (default [{kind: "head"}], the working tree).',
          ),
        concurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many rows may run at once (default 4)."),
        providerId: providerIdParam("eval"),
      }),
      annotations: { openWorldHint: true },
    },
    ({ evalId, arms, concurrency, providerId }) =>
      guard(async () => {
        const provider = evalProvider(providerId);
        const found = evalRunnerOrRefusal(
          context.evalRunner,
          context.executeDisabledMessage,
        );
        if (!found.ok) return relay(found.result);
        await context.runsInterrupted;
        const run = unwrap<EvalRun>(
          await handleStartRun(found.runner, provider, evalId, {
            arms,
            concurrency,
          }),
        );
        return ok({
          runId: run.id,
          evalId: run.evalId,
          providerId: provider.id,
          status: run.status,
          total: run.total,
          arms: run.arms.map(arm => ({
            id: arm.id,
            label: arm.label,
            ...(arm.error && { error: arm.error }),
          })),
          startedAt: run.startedAt,
        });
      }),
  );

  server.registerTool(
    "list_eval_runs",
    {
      title: "List an eval's runs",
      description:
        "Lists an eval's runs, newest first, with each one's status, progress (done of total), and outcome counts.",
      inputSchema: z.object({
        evalId: evalIdParam,
        providerId: providerIdParam("eval"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ evalId, providerId }) =>
      guard(async () =>
        ok(
          unwrap<EvalRunSummary[]>(
            await handleListRuns(evalProvider(providerId), evalId),
          ),
        ),
      ),
  );

  server.registerTool(
    "get_eval_run",
    {
      title: "Get an eval run",
      description:
        "Gets a run's status and progress, a summary per arm (each check's pass rate and mean score, row errors, cost, latency), and its results row by row: the row's inputs, whether it ran, each check's outcome, and the trace it recorded — pass traceProviderId and traceId to get_traces for every span.",
      inputSchema: z.object({
        runId: runIdParam,
        failingOnly: z
          .boolean()
          .optional()
          .describe(
            "Only rows that errored, were skipped, or failed or errored a check.",
          ),
        offset: z.number().int().nonnegative().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("The most result rows to return (default 100)."),
        providerId: providerIdParam("eval"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ runId, failingOnly, offset = 0, limit = 100, providerId }) =>
      guard(async () => {
        const provider = evalProvider(providerId);
        const { run, results, running } = unwrap<EvalRunWithResults>(
          await handleGetRun(context.evalRunner, provider, runId),
        );
        const { definition } = run;
        const fields = (
          await datasetProviders
            .get(definition.dataset.providerId)
            ?.getDataset(definition.dataset.id)
        )?.fields;
        const checkIds = definition.checks.map(c => c.id);
        const checksByRow = new Map<string, EvalCheckResult[]>();
        for (const c of results.checks) {
          const key = `${c.armId}:${c.rowId}`;
          checksByRow.set(key, [...(checksByRow.get(key) ?? []), c]);
        }
        const rows = results.rows
          .map(row => ({
            row,
            checks: checksByRow.get(`${row.armId}:${row.rowId}`) ?? [],
          }))
          .filter(
            ({ row, checks }) =>
              !failingOnly ||
              row.status !== "ok" ||
              checks.some(c => c.outcome === "fail" || c.outcome === "error"),
          )
          .sort(
            (a, b) =>
              a.row.rowIndex - b.row.rowIndex ||
              a.row.armId.localeCompare(b.row.armId),
          );
        return ok({
          id: run.id,
          evalId: run.evalId,
          providerId: provider.id,
          status: run.status,
          running,
          done: results.rows.length,
          total: run.total,
          startedAt: run.startedAt,
          ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
          ...(run.startVersion && { startVersion: run.startVersion }),
          dirty: run.dirty,
          drifted: run.drifted,
          checks: definition.checks.map(c => ({
            id: c.id,
            uri: c.uri,
            ...(c.label && { label: c.label }),
            ...(c.threshold !== undefined && { threshold: c.threshold }),
          })),
          arms: run.arms.map(arm => ({
            id: arm.id,
            label: arm.label,
            spec: arm.spec,
            ...(arm.error && { error: arm.error }),
            ...(arm.conflicts && { conflicts: arm.conflicts }),
            summary: summarizeArm(results, arm.id, checkIds),
          })),
          resultRows: rows.length,
          results: rows
            .slice(offset, offset + limit)
            .map(({ row, checks }) => ({
              rowIndex: row.rowIndex,
              rowId: row.rowId,
              armId: row.armId,
              status: row.status,
              ...(row.error && { error: row.error }),
              inputs: describeCells(row.rowCells, fields ?? []),
              ...(row.traceId && {
                traceProviderId: row.traceProviderId,
                traceId: row.traceId,
              }),
              ...(row.traceIncomplete && { traceIncomplete: true }),
              ...(row.costUsd !== undefined && { costUsd: row.costUsd }),
              ...(row.durationMs !== undefined && {
                durationMs: row.durationMs,
              }),
              checks: checks.map(c => ({
                checkId: c.checkId,
                outcome: c.outcome,
                ...(c.score !== undefined && { score: c.score }),
                ...(c.message && { message: c.message }),
              })),
            })),
        });
      }),
  );

  server.registerTool(
    "cancel_eval_run",
    {
      title: "Cancel an eval run",
      description:
        "Cancels a run in progress: rows already running finish, and the rest don't start. Its results so far are kept.",
      inputSchema: z.object({ runId: runIdParam }),
    },
    ({ runId }) =>
      guard(async () => {
        const found = evalRunnerOrRefusal(
          context.evalRunner,
          context.executeDisabledMessage,
        );
        if (!found.ok) return relay(found.result);
        return relay(handleCancelRun(found.runner, runId));
      }),
  );

  server.registerTool(
    "delete_eval_run",
    {
      title: "Delete an eval run",
      description:
        "Deletes a run with its results; a run still in progress is cancelled first. The traces it recorded are kept.",
      inputSchema: z.object({
        runId: runIdParam,
        providerId: providerIdParam("eval"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ runId, providerId }) =>
      guard(async () =>
        relay(
          await handleDeleteRun(
            context.evalRunner,
            evalProvider(providerId),
            runId,
          ),
          { deleted: runId },
        ),
      ),
  );
}
