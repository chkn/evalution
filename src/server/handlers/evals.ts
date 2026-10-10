// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral handlers for the `/api/evals` routes — resolved providers
 * in, `{ status, body }` out, in the `datasets.ts` style. See
 * `specs/evals.md` §F.
 */

import {
  EvalNotFoundError,
  type EvalProvider,
} from "../../eval/eval-provider.ts";
import {
  type EvalRunner,
  EvalRunRefusedError,
} from "../../eval/eval-runner.ts";
import type {
  EvalArmSpec,
  EvalCheck,
  EvalDefinitionPatch,
  EvalInputs,
  EvalResults,
  EvalRun,
  EvalSummary,
  NewEvalDefinition,
  TraceCheckResult,
} from "../../eval/eval-types.ts";
import {
  InvalidCellError,
  parseBinding,
  parseResources,
} from "../../shared/dataset-cells.ts";
import type { ExecutionInput, PromptID } from "../../shared/types.ts";
import { errorResult, type HandlerResult } from "./result.ts";

/** What an eval handler returns; the route or MCP tool relays it. */
export type EvalHandlerResult = HandlerResult;

/** The body of `GET /api/eval-runs/:providerId/:runId`. */
export interface EvalRunWithResults {
  run: EvalRun;
  results: EvalResults;
  /** Whether the run is still in flight in this server. */
  running: boolean;
}

/** A request body that doesn't fit, reported as a 400. */
class BadRequest extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Relays a provider's or validator's failure as the status it deserves. */
function failure(err: unknown): EvalHandlerResult {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof EvalNotFoundError) {
    return { status: 404, body: { error: message } };
  }
  if (err instanceof EvalRunRefusedError) {
    return { status: 400, body: { error: message, problems: err.problems } };
  }
  if (err instanceof BadRequest || err instanceof InvalidCellError) {
    return { status: 400, body: { error: message } };
  }
  console.error("eval request failed:", err);
  return { status: 500, body: { error: message } };
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequest("name must be a non-empty string");
  }
  return value.trim();
}

function parsePrompt(value: unknown): PromptID {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new BadRequest("prompt must be { id, providerId? }");
  }
  if (value.providerId !== undefined && typeof value.providerId !== "string") {
    throw new BadRequest("prompt.providerId must be a string");
  }
  return {
    id: value.id,
    ...(typeof value.providerId === "string" && {
      providerId: value.providerId,
    }),
  };
}

function parseDataset(value: unknown): { providerId: string; id: string } {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    typeof value.id !== "string" ||
    !value.providerId ||
    !value.id
  ) {
    throw new BadRequest("dataset must be { providerId, id }");
  }
  return { providerId: value.providerId, id: value.id };
}

function parseBindings(
  value: unknown,
  path: string,
): Record<string, ExecutionInput> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new BadRequest(`${path} must be an object`);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, parseBinding(v, `${path}.${k}`)]),
  );
}

function parseInputs(value: unknown): EvalInputs {
  if (value === undefined) return { functionInputs: {}, executeInputs: {} };
  if (!isRecord(value)) {
    throw new BadRequest(
      "inputs must be { functionInputs, executeInputs, resources? }",
    );
  }
  return {
    functionInputs: parseBindings(
      value.functionInputs,
      "inputs.functionInputs",
    ),
    executeInputs: parseBindings(value.executeInputs, "inputs.executeInputs"),
    ...(value.resources !== undefined && {
      resources: parseResources(value.resources, {
        columns: true,
        path: "inputs.resources",
      }),
    }),
  };
}

function parseChecks(value: unknown): EvalCheck[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequest("checks must be an array");
  const ids = new Set<string>();
  return value.map((c, i): EvalCheck => {
    const path = `checks[${i}]`;
    if (!isRecord(c)) throw new BadRequest(`${path} must be an object`);
    if (typeof c.id !== "string" || !c.id) {
      throw new BadRequest(`${path}.id must be a non-empty string`);
    }
    if (ids.has(c.id)) throw new BadRequest(`${path}.id repeats '${c.id}'`);
    ids.add(c.id);
    if (typeof c.uri !== "string" || !c.uri) {
      throw new BadRequest(`${path}.uri must be a non-empty string`);
    }
    if (c.label !== undefined && typeof c.label !== "string") {
      throw new BadRequest(`${path}.label must be a string`);
    }
    if (
      c.threshold !== undefined &&
      c.threshold !== null &&
      (typeof c.threshold !== "number" || !Number.isFinite(c.threshold))
    ) {
      throw new BadRequest(`${path}.threshold must be a number`);
    }
    return {
      id: c.id,
      uri: c.uri,
      ...(typeof c.label === "string" && c.label && { label: c.label }),
      args: parseBindings(c.args, `${path}.args`),
      ...(typeof c.threshold === "number" && { threshold: c.threshold }),
    };
  });
}

function parseNewEval(body: unknown): NewEvalDefinition {
  if (!isRecord(body)) {
    throw new BadRequest(
      "body must be { name, prompt, dataset, inputs?, checks? }",
    );
  }
  return {
    name: parseName(body.name),
    prompt: parsePrompt(body.prompt),
    dataset: parseDataset(body.dataset),
    inputs: parseInputs(body.inputs),
    checks: parseChecks(body.checks),
  };
}

function parsePatch(body: unknown): EvalDefinitionPatch {
  if (!isRecord(body)) throw new BadRequest("body must be an object");
  return {
    ...(body.name !== undefined && { name: parseName(body.name) }),
    ...(body.prompt !== undefined && { prompt: parsePrompt(body.prompt) }),
    ...(body.dataset !== undefined && { dataset: parseDataset(body.dataset) }),
    ...(body.inputs !== undefined && { inputs: parseInputs(body.inputs) }),
    ...(body.checks !== undefined && { checks: parseChecks(body.checks) }),
  };
}

function parseArms(value: unknown): EvalArmSpec[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequest("arms must be a non-empty array");
  }
  return value.map((a, i): EvalArmSpec => {
    if (!isRecord(a)) throw new BadRequest(`arms[${i}] must be an object`);
    if (a.kind === "head") return { kind: "head" };
    if (
      (a.kind === "wip" || a.kind === "variation") &&
      typeof a.variation === "string" &&
      a.variation
    ) {
      return a.kind === "wip"
        ? { kind: "wip", variation: a.variation }
        : {
            kind: "variation",
            variation: a.variation,
            ...(typeof a.label === "string" && { label: a.label }),
          };
    }
    throw new BadRequest(
      `arms[${i}] must be { kind: "head" } or { kind: "wip" | "variation", variation }`,
    );
  });
}

/** `GET /api/evals` — every provider's evals, newest first. */
export async function handleListEvals(
  providers: Iterable<EvalProvider>,
): Promise<EvalHandlerResult> {
  try {
    const all: EvalSummary[] = [];
    for (const provider of providers) {
      for (const e of await provider.listEvals()) {
        all.push({ ...e, providerId: provider.id });
      }
    }
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return { status: 200, body: all };
  } catch (err) {
    return failure(err);
  }
}

/** `POST /api/evals/:providerId` */
export async function handleCreateEval(
  provider: EvalProvider,
  body: unknown,
): Promise<EvalHandlerResult> {
  try {
    return { status: 201, body: await provider.createEval(parseNewEval(body)) };
  } catch (err) {
    return failure(err);
  }
}

/** `GET /api/evals/:providerId/:id` */
export async function handleGetEval(
  provider: EvalProvider,
  id: string,
): Promise<EvalHandlerResult> {
  try {
    const found = await provider.getEval(id);
    return found
      ? { status: 200, body: found }
      : { status: 404, body: { error: `Eval not found: ${id}` } };
  } catch (err) {
    return failure(err);
  }
}

/** `PATCH /api/evals/:providerId/:id` */
export async function handleUpdateEval(
  provider: EvalProvider,
  id: string,
  body: unknown,
): Promise<EvalHandlerResult> {
  try {
    return {
      status: 200,
      body: await provider.updateEval(id, parsePatch(body)),
    };
  } catch (err) {
    return failure(err);
  }
}

/** `DELETE /api/evals/:providerId/:id` */
export async function handleDeleteEval(
  provider: EvalProvider,
  id: string,
): Promise<EvalHandlerResult> {
  try {
    await provider.deleteEval(id);
    return { status: 204, body: undefined };
  } catch (err) {
    return failure(err);
  }
}

/** `POST /api/evals/:providerId/:id/runs` — body `{ arms?, concurrency? }`. */
export async function handleStartRun(
  runner: EvalRunner,
  provider: EvalProvider,
  id: string,
  body: unknown,
): Promise<EvalHandlerResult> {
  try {
    const options = body === undefined ? {} : body;
    if (!isRecord(options)) {
      throw new BadRequest("body must be { arms?, concurrency? }");
    }
    const { concurrency } = options;
    if (
      concurrency !== undefined &&
      (typeof concurrency !== "number" ||
        !Number.isInteger(concurrency) ||
        concurrency < 1)
    ) {
      throw new BadRequest("concurrency must be a positive integer");
    }
    const arms = parseArms(options.arms);
    const run = await runner.start(provider, id, {
      ...(arms && { arms }),
      ...(concurrency !== undefined && { concurrency }),
    });
    return { status: 201, body: run };
  } catch (err) {
    return failure(err);
  }
}

/** `GET /api/evals/:providerId/:id/runs` */
export async function handleListRuns(
  provider: EvalProvider,
  id: string,
): Promise<EvalHandlerResult> {
  try {
    return { status: 200, body: await provider.listRuns(id) };
  } catch (err) {
    return failure(err);
  }
}

/**
 * The runner to start or cancel a run with, or why runs can't be started
 * here: execution is disabled (`executeDisabledMessage`), or there's no trace
 * provider for runs to record their traces in.
 */
export function evalRunnerOrRefusal(
  runner: EvalRunner | undefined,
  executeDisabledMessage: string | undefined,
): { ok: true; runner: EvalRunner } | { ok: false; result: EvalHandlerResult } {
  if (executeDisabledMessage) {
    return { ok: false, result: errorResult(400, executeDisabledMessage) };
  }
  if (!runner) {
    return {
      ok: false,
      result: errorResult(400, "No trace provider to run on"),
    };
  }
  return { ok: true, runner };
}

/**
 * `GET /api/eval-runs/:providerId/:runId` — the run with its results.
 * Without a `runner`, no run is reported as running.
 */
export async function handleGetRun(
  runner: EvalRunner | undefined,
  provider: EvalProvider,
  runId: string,
): Promise<EvalHandlerResult> {
  try {
    const run = await provider.getRun(runId);
    if (!run) {
      return { status: 404, body: { error: `Run not found: ${runId}` } };
    }
    const body: EvalRunWithResults = {
      run,
      results: await provider.listResults(runId),
      running: runner?.isRunning(runId) ?? false,
    };
    return { status: 200, body };
  } catch (err) {
    return failure(err);
  }
}

/** `POST /api/eval-runs/:providerId/:runId/cancel` */
export function handleCancelRun(
  runner: EvalRunner,
  runId: string,
): EvalHandlerResult {
  return runner.cancel(runId)
    ? { status: 202, body: { cancelled: true } }
    : { status: 409, body: { error: "The run isn't running" } };
}

/**
 * `DELETE /api/eval-runs/:providerId/:runId` — a run in flight is cancelled,
 * and its rows left to finish, first, so none is recorded after it's gone.
 */
export async function handleDeleteRun(
  runner: EvalRunner | undefined,
  provider: EvalProvider,
  runId: string,
): Promise<EvalHandlerResult> {
  try {
    if (runner?.cancel(runId)) await runner.finished(runId);
    await provider.deleteRun(runId);
    return { status: 204, body: undefined };
  } catch (err) {
    return failure(err);
  }
}

/** `GET /api/traces/:providerId/:id/check-results` — across every eval provider. */
export async function handleTraceCheckResults(
  providers: Iterable<EvalProvider>,
  traceProviderId: string,
  traceId: string,
): Promise<EvalHandlerResult> {
  try {
    const all: (TraceCheckResult & { providerId: string })[] = [];
    for (const provider of providers) {
      for (const r of await provider.resultsForTrace(
        traceProviderId,
        traceId,
      )) {
        all.push({ ...r, providerId: provider.id });
      }
    }
    return { status: 200, body: all };
  } catch (err) {
    return failure(err);
  }
}
