// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  EvalArmSpec,
  EvalDefinition,
  EvalDefinitionPatch,
  EvalProviderInfo,
  EvalResults,
  EvalRun,
  EvalRunSummary,
  EvalSummary,
  NewEvalDefinition,
  TraceCheckResult,
} from "../eval/eval-types";
import type { AddDatasetFieldRequest } from "../shared/dataset-fields";
import type { SetupTask } from "../shared/setup-task";
import type {
  AddPromptContext,
  Annotation,
  AnnotationKind,
  CheckInfo,
  ConflictChoices,
  Dataset,
  DatasetField,
  DatasetProviderInfo,
  DatasetRow,
  DatasetRowsOverview,
  DatasetRowUpdate,
  DatasetSummary,
  ExecuteRequest,
  ExecuteResponse,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PromptID,
  PromptProviderInfo,
  PromptRef,
  PromptStyle,
  PropDefinition,
  RebaseResult,
  TraceLiveEvent,
  TraceProviderInfo,
  TraceSummary,
  TraceWithSpans,
  UpdatePromptResponse,
  VariationInfo,
  VersionInfo,
} from "../shared/types";
import { markSelfEdit } from "./self-edits.ts";
import { encodePromptId } from "./utils";

function promptUrl(
  prompt: Pick<NormalizedPrompt, "id" | "providerId">,
  suffix: string,
  ref?: Partial<Pick<PromptRef, "version" | "variation">>,
): string {
  return `/api/prompts/${prompt.providerId}/${encodePromptId(prompt.id)}/${suffix}${refQuery(ref)}`;
}

/** `?version=` / `?variation=` for a non-head ref; nothing for head. */
export function refQuery(
  ref?: Partial<Pick<PromptRef, "version" | "variation">>,
): string {
  if (ref?.variation) return `?variation=${encodeURIComponent(ref.variation)}`;
  if (ref?.version) return `?version=${encodeURIComponent(ref.version)}`;
  return "";
}

async function throwIfError(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
}

/** Onboarding setup tasks, split into coding-agent launchers and AI SDKs. */
export interface SetupTasks {
  /** Coding-agent launchers shown as one-click buttons. */
  agent: SetupTask[];
  /** AI SDKs shown in the manual-setup picker. */
  sdk: SetupTask[];
}

/** Fetches the onboarding setup tasks (coding agents and AI SDKs). */
export async function getSetupTasks(): Promise<SetupTasks> {
  const res = await fetch("/api/setup-tasks");
  await throwIfError(res);
  return res.json();
}

/** Result of executing a setup step via {@link executeSetupStep}. */
export interface ExecuteSetupStepResult {
  /** For a `create_config` step: the project-relative path that was written. */
  path?: string;
}

/**
 * Runs a single onboarding step by id. The server resolves the step from its
 * own registry, so no file contents or commands are sent from the client.
 */
export async function executeSetupStep(
  taskId: string,
  stepId: string,
): Promise<ExecuteSetupStepResult> {
  const res = await fetch(
    `/api/setup-tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}/execute`,
    { method: "POST" },
  );
  await throwIfError(res);
  return res.json();
}

export async function getPromptProviders(): Promise<PromptProviderInfo[]> {
  const res = await fetch("/api/providers");
  await throwIfError(res);
  return res.json();
}

export async function addPrompt(
  providerId: string,
  partial: Record<string, any>,
): Promise<NormalizedPrompt | AddPromptContext> {
  const res = await fetch(`/api/providers/${providerId}/add-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  await throwIfError(res);
  const result = await res.json();
  // Ignore the echo for a prompt we just created (local state is patched).
  if (result && "id" in result) markSelfEdit("add", providerId, result.id);
  return result;
}

export async function getPrompts(): Promise<NormalizedPrompt[]> {
  const res = await fetch("/api/prompts");
  await throwIfError(res);
  return res.json();
}

/**
 * The SDK's model slot for a provider's prompts of `style`, catalogs included,
 * or `null` if it has none.
 */
export async function getModelDefinition(
  providerId: string,
  style: PromptStyle,
): Promise<PropDefinition | null> {
  const res = await fetch(
    `/api/providers/${providerId}/model-definition?style=${style}`,
  );
  await throwIfError(res);
  return res.json();
}

export async function getModelParameters(
  providerId: string,
): Promise<PropDefinition[]> {
  const res = await fetch(`/api/providers/${providerId}/model-parameters`);
  await throwIfError(res);
  return res.json();
}

export async function renamePrompt(
  prompt: NormalizedPrompt,
  newName: string,
): Promise<NormalizedPrompt> {
  // Renaming rewrites the file; ignore the echo for the renamed prompt's new id.
  const hash = prompt.id.lastIndexOf("#");
  const newId =
    hash >= 0 ? `${prompt.id.slice(0, hash + 1)}${newName}` : prompt.id;
  if (prompt.providerId) markSelfEdit("change", prompt.providerId, newId);
  const res = await fetch(promptUrl(prompt, "rename"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName }),
  });
  await throwIfError(res);
  return res.json();
}

/**
 * The prompt `ref` names — a version, or a variation — as the server reads it.
 * A version that is what's on disk now comes back as head.
 */
export async function getPromptAt(
  providerId: string,
  promptId: string,
  ref: PromptRef,
): Promise<NormalizedPrompt> {
  const res = await fetch(
    `/api/prompts/${providerId}/${encodePromptId(promptId)}${refQuery(ref)}`,
  );
  await throwIfError(res);
  return res.json();
}

/**
 * Applies `updates` at `ref` (head when omitted). With variations, the server
 * collects them in a work-in-progress variation rather than writing the file;
 * the response says where they landed.
 */
export async function updatePromptProperties(
  prompt: NormalizedPrompt,
  updates: NormalizedPromptUpdates,
  ref?: PromptRef,
): Promise<UpdatePromptResponse> {
  // Updating changes the prompt; ignore the resulting echo for this prompt.
  if (prompt.providerId) markSelfEdit("change", prompt.providerId, prompt.id);
  const res = await fetch(promptUrl(prompt, "update", ref), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  await throwIfError(res);
  return res.json();
}

/**
 * Starts a prompt run.
 *
 * Inputs are sent **unresolved**: a resource reference has no value until the
 * server creates one, and a value's import bindings cannot be imported in a
 * browser at all. Resolution therefore happens server-side, immediately before
 * the prompt is called.
 *
 * @param prompt - The prompt to run.
 * @param inputs - Positional function inputs and named execute inputs.
 */
export async function executePrompt(
  prompt: NormalizedPrompt,
  inputs: ExecuteRequest,
  ref?: PromptRef,
): Promise<ExecuteResponse> {
  const res = await fetch(promptUrl(prompt, "execute", ref), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(inputs),
  });
  await throwIfError(res);
  return res.json();
}

/** Versions that changed `prompt`'s file, newest first. */
export async function getPromptVersions(
  prompt: Pick<NormalizedPrompt, "id" | "providerId">,
  { limit, before }: { limit?: number; before?: string } = {},
): Promise<VersionInfo[]> {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (before) params.set("before", before);
  const query = params.size ? `?${params}` : "";
  const res = await fetch(promptUrl(prompt, "versions") + query);
  await throwIfError(res);
  return res.json();
}

/** `prompt`'s named variations and unsaved edits. */
export async function getPromptVariations(
  prompt: Pick<NormalizedPrompt, "id" | "providerId">,
): Promise<VariationInfo[]> {
  const res = await fetch(promptUrl(prompt, "variations"));
  await throwIfError(res);
  return res.json();
}

function variationUrl(providerId: string, id: string, suffix = ""): string {
  return `/api/variations/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}${suffix}`;
}

async function postVariation<T>(
  providerId: string,
  id: string,
  action: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(variationUrl(providerId, id, `/${action}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  await throwIfError(res);
  return res.status === 204 ? (undefined as T) : res.json();
}

/** Writes a WIP variation into the prompt's source, and drops it. */
export function saveVariation(
  providerId: string,
  id: string,
): Promise<RebaseResult> {
  return postVariation(providerId, id, "save");
}

/** Drops a WIP variation. */
export function discardVariation(
  providerId: string,
  id: string,
): Promise<void> {
  return postVariation(providerId, id, "discard");
}

/** Brings a variation's changes into the unsaved edits at head. */
export function openVariationOnHead(
  providerId: string,
  id: string,
  options: OpenOnHeadRequest = {},
): Promise<RebaseResult> {
  return postVariation(providerId, id, "open-on-head", options);
}

/**
 * How to settle conflicts when opening on head: discard the unsaved edits
 * there first, or pick a side per field. Without either, a conflict changes
 * nothing and is reported back.
 */
export interface OpenOnHeadRequest {
  replace?: boolean;
  choices?: ConflictChoices;
}

/** Brings an old version's prompt into the unsaved edits at head. */
export async function openVersionOnHead(
  prompt: Pick<NormalizedPrompt, "id" | "providerId">,
  version: string,
  options: OpenOnHeadRequest = {},
): Promise<RebaseResult> {
  const res = await fetch(promptUrl(prompt, "open-on-head", { version }), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  await throwIfError(res);
  return res.json();
}

/** Settles a WIP's conflicts with a choice per field. */
export function resolveVariation(
  providerId: string,
  id: string,
  choices: ConflictChoices,
): Promise<RebaseResult> {
  return postVariation(providerId, id, "resolve", { choices });
}

/** Names a variation (a WIP's current edits are frozen and named). */
export async function nameVariation(
  providerId: string,
  id: string,
  name: string,
): Promise<VariationInfo> {
  const res = await fetch(variationUrl(providerId, id, "/name"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await throwIfError(res);
  return res.json();
}

/** Describes variations by id, across providers. Unknown ids are absent. */
export async function lookupVariations(
  ids: string[],
): Promise<Record<string, VariationInfo & { providerId: string }>> {
  if (ids.length === 0) return {};
  const res = await fetch(
    `/api/variations?ids=${ids.map(encodeURIComponent).join(",")}`,
  );
  await throwIfError(res);
  return res.json();
}

export async function getTraceProviders(): Promise<TraceProviderInfo[]> {
  const res = await fetch("/api/trace-providers");
  await throwIfError(res);
  return res.json();
}

export async function getTraces(): Promise<TraceSummary[]> {
  const res = await fetch("/api/traces");
  await throwIfError(res);
  return res.json();
}

/** Deletes a trace along with its spans and annotations. */
export async function deleteTrace(
  providerId: string,
  traceId: string,
): Promise<void> {
  const res = await fetch(
    `/api/traces/${encodeURIComponent(providerId)}/${encodeURIComponent(traceId)}`,
    { method: "DELETE" },
  );
  await throwIfError(res);
}

/** Options for {@link getTrace}'s "wait for a freshly-started trace" polling. */
export interface GetTraceOptions {
  /** Aborts the in-flight request and stops polling. */
  signal?: AbortSignal;
  /** How long to keep retrying a 404 before giving up. Default 10s. */
  timeoutMs?: number;
  /** Delay between 404 retries. Default 150ms. */
  intervalMs?: number;
}

/**
 * Fetches a trace together with its spans.
 *
 * A just-executed trace may not exist on the server yet: the execute route
 * returns a trace id before the telemetry ingestor records the first span and
 * creates the trace. So a `404` is treated as "not started yet" and retried —
 * polling every `intervalMs` up to `timeoutMs` — rather than surfaced
 * immediately. Any other error (or a 404 that outlasts the timeout) throws.
 */
export async function getTrace(
  providerId: string,
  traceId: string,
  { signal, timeoutMs = 10_000, intervalMs = 150 }: GetTraceOptions = {},
): Promise<TraceWithSpans> {
  const url = `/api/traces/${encodeURIComponent(providerId)}/${encodeURIComponent(traceId)}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(url, { signal });
    if (res.ok) return res.json();
    // Only a 404 (trace not created yet) is retryable, and only until the
    // deadline; everything else throws right away.
    if (res.status !== 404 || Date.now() >= deadline) {
      await throwIfError(res);
    }
    await delay(intervalMs, signal);
  }
}

/** Resolves after `ms`, or rejects if `signal` aborts first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Opens an SSE subscription for the given trace. The callback is invoked for
 * each {@link TraceLiveEvent} — span/trace lifecycle events and annotation
 * changes ride the same connection. Returns a cleanup function that closes
 * the underlying connection.
 */
export function subscribeTraceEvents(
  providerId: string,
  traceId: string,
  onEvent: (event: TraceLiveEvent) => void,
): () => void {
  const url = `/api/traces/${encodeURIComponent(providerId)}/${encodeURIComponent(traceId)}/events`;
  const es = new EventSource(url);
  es.onmessage = msg => {
    try {
      const data = JSON.parse(msg.data);
      if (data?.type && data.type !== "connected") {
        onEvent(data as TraceLiveEvent);
      }
    } catch {
      /* ignore malformed payloads */
    }
  };
  return () => es.close();
}

function annotationsUrl(
  providerId: string,
  traceId: string,
  suffix = "",
): string {
  return `/api/traces/${encodeURIComponent(providerId)}/${encodeURIComponent(traceId)}/annotations${suffix}`;
}

/** Lists every annotation on a trace, oldest first. */
export async function getAnnotations(
  providerId: string,
  traceId: string,
): Promise<Annotation[]> {
  const res = await fetch(annotationsUrl(providerId, traceId));
  await throwIfError(res);
  return res.json();
}

/** Creates a new annotation on a trace, or on one specific span within it. */
export async function createAnnotation(
  providerId: string,
  traceId: string,
  input: { kind: AnnotationKind; note: string; spanId?: string },
): Promise<Annotation> {
  const res = await fetch(annotationsUrl(providerId, traceId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await throwIfError(res);
  return res.json();
}

/** Deletes an annotation by id. */
export async function deleteAnnotation(
  providerId: string,
  traceId: string,
  id: string,
): Promise<void> {
  const res = await fetch(
    annotationsUrl(providerId, traceId, `/${encodeURIComponent(id)}`),
    {
      method: "DELETE",
    },
  );
  await throwIfError(res);
}

function datasetUrl(
  providerId: string,
  datasetId?: string,
  suffix = "",
): string {
  const base = `/api/datasets/${encodeURIComponent(providerId)}`;
  return datasetId ? `${base}/${encodeURIComponent(datasetId)}${suffix}` : base;
}

/** Every dataset across every dataset provider, most recently updated first. */
export async function getDatasets(): Promise<DatasetSummary[]> {
  const res = await fetch("/api/datasets");
  await throwIfError(res);
  return res.json();
}

/**
 * A dataset with an overview of its rows — their count and the keys inside
 * their cells. The rows themselves are paged in with {@link getDatasetRows}.
 */
export async function getDataset(
  providerId: string,
  datasetId: string,
): Promise<{ dataset: Dataset } & DatasetRowsOverview> {
  const res = await fetch(datasetUrl(providerId, datasetId));
  await throwIfError(res);
  return res.json();
}

/** One page of a dataset's rows, oldest first. */
export async function getDatasetRows(
  providerId: string,
  datasetId: string,
  offset: number,
  limit: number,
): Promise<DatasetRow[]> {
  const res = await fetch(
    datasetUrl(providerId, datasetId, `/rows?offset=${offset}&limit=${limit}`),
  );
  await throwIfError(res);
  return res.json();
}

/** Creates a dataset. Field ids are minted by the server. */
export async function createDataset(
  providerId: string,
  input: {
    name: string;
    fields: Omit<DatasetField, "id">[];
    prompt?: PromptID;
  },
): Promise<Dataset> {
  const res = await fetch(datasetUrl(providerId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await throwIfError(res);
  return res.json();
}

/**
 * Creates a dataset from nothing but a name — no fields, no prompt link — on
 * the first dataset provider (the one "Add to dataset" creates in too), as
 * the sidebar's "New dataset…" does. Returns it as the sidebar lists it.
 */
export async function createEmptyDataset(
  name: string,
): Promise<DatasetSummary> {
  const [provider] = await getDatasetProviders();
  if (!provider) throw new Error("No dataset provider is configured");
  const dataset = await createDataset(provider.id, { name, fields: [] });
  return {
    providerId: provider.id,
    id: dataset.id,
    name: dataset.name,
    rowCount: 0,
    fields: dataset.fields,
    updatedAt: dataset.updatedAt,
  };
}

/** Renames a dataset. */
export async function renameDataset(
  providerId: string,
  datasetId: string,
  name: string,
): Promise<Dataset> {
  const res = await fetch(datasetUrl(providerId, datasetId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await throwIfError(res);
  return res.json();
}

/** Deletes a dataset and all its rows. */
export async function deleteDataset(
  providerId: string,
  datasetId: string,
): Promise<void> {
  const res = await fetch(datasetUrl(providerId, datasetId), {
    method: "DELETE",
  });
  await throwIfError(res);
}

/** Appends rows to a dataset. */
export async function addDatasetRows(
  providerId: string,
  datasetId: string,
  rows: Pick<DatasetRow, "cells" | "source">[],
): Promise<DatasetRow[]> {
  const res = await fetch(datasetUrl(providerId, datasetId, "/rows"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  await throwIfError(res);
  return res.json();
}

/**
 * Sets or clears cells on several rows of a dataset in one all-or-nothing
 * batch. A `null` cell clears.
 */
export async function updateDatasetRows(
  providerId: string,
  datasetId: string,
  updates: DatasetRowUpdate[],
): Promise<void> {
  const res = await fetch(datasetUrl(providerId, datasetId, "/rows"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  await throwIfError(res);
}

/**
 * Appends a field to a dataset. Rejected (with the server's message) when a
 * field of the same name and type already exists.
 */
export async function addDatasetField(
  providerId: string,
  datasetId: string,
  request: AddDatasetFieldRequest,
): Promise<DatasetField> {
  const res = await fetch(datasetUrl(providerId, datasetId, "/fields"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  await throwIfError(res);
  return res.json();
}

/**
 * Renames a dataset's field. Its id never changes, so rows are untouched.
 * Rejected (with the server's message) when another field would then have the
 * same name and type.
 */
export async function renameDatasetField(
  providerId: string,
  datasetId: string,
  fieldId: string,
  name: string,
): Promise<DatasetField> {
  const res = await fetch(
    datasetUrl(providerId, datasetId, `/fields/${encodeURIComponent(fieldId)}`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  await throwIfError(res);
  return res.json();
}

/** Deletes a dataset's field and every row's cell for it. */
export async function deleteDatasetField(
  providerId: string,
  datasetId: string,
  fieldId: string,
): Promise<void> {
  const res = await fetch(
    datasetUrl(providerId, datasetId, `/fields/${encodeURIComponent(fieldId)}`),
    { method: "DELETE" },
  );
  await throwIfError(res);
}

/** Deletes one row of a dataset. */
export async function deleteDatasetRow(
  providerId: string,
  datasetId: string,
  rowId: string,
): Promise<void> {
  const res = await fetch(
    datasetUrl(providerId, datasetId, `/rows/${encodeURIComponent(rowId)}`),
    { method: "DELETE" },
  );
  await throwIfError(res);
}

/** Every configured dataset provider. */
export async function getDatasetProviders(): Promise<DatasetProviderInfo[]> {
  const res = await fetch("/api/dataset-providers");
  await throwIfError(res);
  return res.json();
}

// #region Evals — `specs/evals.md` §F

function evalUrl(providerId: string, evalId?: string, suffix = ""): string {
  const base = `/api/evals/${encodeURIComponent(providerId)}`;
  return evalId ? `${base}/${encodeURIComponent(evalId)}${suffix}` : base;
}

function evalRunUrl(providerId: string, runId: string, suffix = ""): string {
  return `/api/eval-runs/${encodeURIComponent(providerId)}/${encodeURIComponent(runId)}${suffix}`;
}

/** Thrown by {@link startEvalRun} when the eval has problems that stop it running. */
export class EvalRunRefused extends Error {
  /** What's wrong, one line each. */
  readonly problems: string[];

  constructor(message: string, problems: string[]) {
    super(message);
    this.problems = problems;
  }
}

/** Every configured eval provider. */
export async function getEvalProviders(): Promise<EvalProviderInfo[]> {
  const res = await fetch("/api/eval-providers");
  await throwIfError(res);
  return res.json();
}

/** Every eval across every eval provider, most recently updated first. */
export async function getEvals(): Promise<EvalSummary[]> {
  const res = await fetch("/api/evals");
  await throwIfError(res);
  return res.json();
}

/** An eval's definition. */
export async function getEval(
  providerId: string,
  evalId: string,
): Promise<EvalDefinition> {
  const res = await fetch(evalUrl(providerId, evalId));
  await throwIfError(res);
  return res.json();
}

/**
 * Creates an eval on `providerId`, or on the first eval provider when
 * omitted.
 */
export async function createEval(
  definition: NewEvalDefinition,
  providerId?: string,
): Promise<EvalDefinition & { providerId: string }> {
  const target = providerId ?? (await getEvalProviders())[0]?.id;
  if (!target) throw new Error("No eval provider is configured");
  const res = await fetch(evalUrl(target), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(definition),
  });
  await throwIfError(res);
  return { ...(await res.json()), providerId: target };
}

/** Changes any of an eval's fields. */
export async function updateEval(
  providerId: string,
  evalId: string,
  patch: EvalDefinitionPatch,
): Promise<EvalDefinition> {
  const res = await fetch(evalUrl(providerId, evalId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await throwIfError(res);
  return res.json();
}

/** Deletes an eval, with its runs. */
export async function deleteEval(
  providerId: string,
  evalId: string,
): Promise<void> {
  const res = await fetch(evalUrl(providerId, evalId), { method: "DELETE" });
  await throwIfError(res);
}

/**
 * Starts a run of an eval. Rejects with {@link EvalRunRefused} when the eval
 * has problems.
 */
export async function startEvalRun(
  providerId: string,
  evalId: string,
  options: { arms?: EvalArmSpec[]; concurrency?: number } = {},
): Promise<EvalRun> {
  const res = await fetch(evalUrl(providerId, evalId, "/runs"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (Array.isArray(body.problems)) {
      throw new EvalRunRefused(body.error, body.problems);
    }
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

/** An eval's runs, newest first. */
export async function getEvalRuns(
  providerId: string,
  evalId: string,
): Promise<EvalRunSummary[]> {
  const res = await fetch(evalUrl(providerId, evalId, "/runs"));
  await throwIfError(res);
  return res.json();
}

/** A run with its results. */
export async function getEvalRun(
  providerId: string,
  runId: string,
): Promise<{ run: EvalRun; results: EvalResults; running: boolean }> {
  const res = await fetch(evalRunUrl(providerId, runId));
  await throwIfError(res);
  return res.json();
}

/** Cancels a running run: queued rows are skipped, rows in flight finish. */
export async function cancelEvalRun(
  providerId: string,
  runId: string,
): Promise<void> {
  const res = await fetch(evalRunUrl(providerId, runId, "/cancel"), {
    method: "POST",
  });
  await throwIfError(res);
}

/**
 * Deletes a run with its results. A run in flight is cancelled first, so this
 * resolves once its rows in flight have stopped.
 */
export async function deleteEvalRun(
  providerId: string,
  runId: string,
): Promise<void> {
  const res = await fetch(evalRunUrl(providerId, runId), { method: "DELETE" });
  await throwIfError(res);
}

/** Every prompt provider's checks. */
export async function getChecks(): Promise<
  { providerId: string; checks: CheckInfo[] }[]
> {
  const res = await fetch("/api/checks");
  await throwIfError(res);
  return res.json();
}

/** The check results recorded against a trace, from any eval. */
export async function getTraceCheckResults(
  providerId: string,
  traceId: string,
): Promise<(TraceCheckResult & { providerId: string })[]> {
  const res = await fetch(
    `/api/traces/${encodeURIComponent(providerId)}/${encodeURIComponent(traceId)}/check-results`,
  );
  await throwIfError(res);
  return res.json();
}

// #endregion

/**
 * Whether `providerId`'s working tree is clean, and at which commit — what
 * the eval run dialog warns about. `versioned: false` without versions.
 */
export async function getProviderHead(
  providerId: string,
): Promise<{ versioned: boolean; clean: boolean; commit?: VersionInfo }> {
  const res = await fetch(
    `/api/prompt-providers/${encodeURIComponent(providerId)}/head`,
  );
  await throwIfError(res);
  return res.json();
}
