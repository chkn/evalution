// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { SetupTask } from "../shared/setup-task";
import type {
  AddPromptContext,
  ExecuteResponse,
  ModelCatalog,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PromptProviderInfo,
  PropDefinition,
  TraceProviderInfo,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "../shared/types";
import { markSelfEdit } from "./self-edits.ts";
import { encodePromptId } from "./utils";

function promptUrl(prompt: NormalizedPrompt, suffix: string): string {
  return `/api/prompts/${prompt.providerId}/${encodePromptId(prompt.id)}/${suffix}`;
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

export async function getModelCatalog(
  providerId: string,
): Promise<ModelCatalog> {
  const res = await fetch(`/api/providers/${providerId}/models`);
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

export async function updatePromptProperties(
  prompt: NormalizedPrompt,
  updates: NormalizedPromptUpdates,
): Promise<NormalizedPrompt> {
  // Updating rewrites the file; ignore the resulting echo for this prompt.
  if (prompt.providerId) markSelfEdit("change", prompt.providerId, prompt.id);
  const res = await fetch(promptUrl(prompt, "update"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  await throwIfError(res);
  return res.json();
}

export async function executePrompt(
  prompt: NormalizedPrompt,
  functionParams: any[],
): Promise<ExecuteResponse> {
  const res = await fetch(promptUrl(prompt, "execute"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ functionParams }),
  });
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
 * each {@link TraceStreamEvent}. Returns a cleanup function that closes the
 * underlying connection.
 */
export function subscribeTraceEvents(
  providerId: string,
  traceId: string,
  onEvent: (event: TraceStreamEvent) => void,
): () => void {
  const url = `/api/traces/${encodeURIComponent(providerId)}/${encodeURIComponent(traceId)}/events`;
  const es = new EventSource(url);
  es.onmessage = msg => {
    try {
      const data = JSON.parse(msg.data);
      if (data?.type && data.type !== "connected") {
        onEvent(data as TraceStreamEvent);
      }
    } catch {
      /* ignore malformed payloads */
    }
  };
  return () => es.close();
}
