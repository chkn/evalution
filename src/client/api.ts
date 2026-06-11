// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PropDefinition,
  AddPromptContext,
  PromptProviderInfo,
  ModelCatalog,
  ExecuteResponse,
  TraceSummary,
  TraceWithSpans,
  TraceStreamEvent,
  TraceProviderInfo,
} from '../shared/types';
import type { SetupTask } from '../shared/setup-task';
import { encodePromptId } from './utils';

function promptUrl(prompt: NormalizedPrompt, suffix: string): string {
  return `/api/prompts/${prompt.providerId}/${encodePromptId(prompt.id)}/${suffix}`;
}

async function throwIfError(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
}

/** Fetches the onboarding setup tasks shown in the manual-setup picker. */
export async function getSetupTasks(): Promise<SetupTask[]> {
  const res = await fetch('/api/setup-tasks');
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
    { method: 'POST' },
  );
  await throwIfError(res);
  return res.json();
}

export async function getPromptProviders(): Promise<PromptProviderInfo[]> {
  const res = await fetch('/api/providers');
  await throwIfError(res);
  return res.json();
}

export async function addPrompt(
  providerId: string,
  partial: Record<string, any>
): Promise<NormalizedPrompt | AddPromptContext> {
  const res = await fetch(`/api/providers/${providerId}/add-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  await throwIfError(res);
  return res.json();
}

export async function getPrompts(): Promise<NormalizedPrompt[]> {
  const res = await fetch('/api/prompts');
  await throwIfError(res);
  return res.json();
}

export async function getModelCatalog(providerId: string): Promise<ModelCatalog> {
  const res = await fetch(`/api/providers/${providerId}/models`);
  await throwIfError(res);
  return res.json();
}

export async function getModelParameters(providerId: string): Promise<PropDefinition[]> {
  const res = await fetch(`/api/providers/${providerId}/model-parameters`);
  await throwIfError(res);
  return res.json();
}

export async function renamePrompt(prompt: NormalizedPrompt, newName: string): Promise<NormalizedPrompt> {
  const res = await fetch(promptUrl(prompt, 'rename'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName }),
  });
  await throwIfError(res);
  return res.json();
}

export async function updatePromptProperties(
  prompt: NormalizedPrompt,
  updates: NormalizedPromptUpdates
): Promise<NormalizedPrompt> {
  const res = await fetch(promptUrl(prompt, 'update'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  await throwIfError(res);
  return res.json();
}

export async function executePrompt(
  prompt: NormalizedPrompt,
  functionParams: any[]
): Promise<ExecuteResponse> {
  const res = await fetch(promptUrl(prompt, 'execute'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ functionParams }),
  });
  await throwIfError(res);
  return res.json();
}

export async function getTraceProviders(): Promise<TraceProviderInfo[]> {
  const res = await fetch('/api/trace-providers');
  await throwIfError(res);
  return res.json();
}

export async function getTraces(): Promise<TraceSummary[]> {
  const res = await fetch('/api/traces');
  await throwIfError(res);
  return res.json();
}

export async function getTrace(
  providerId: string,
  traceId: string
): Promise<TraceWithSpans> {
  const res = await fetch(`/api/traces/${encodeURIComponent(providerId)}/${encodeURIComponent(traceId)}`);
  await throwIfError(res);
  return res.json();
}

/**
 * Opens an SSE subscription for the given trace. The callback is invoked for
 * each {@link TraceStreamEvent}. Returns a cleanup function that closes the
 * underlying connection.
 */
export function subscribeTraceEvents(
  providerId: string,
  traceId: string,
  onEvent: (event: TraceStreamEvent) => void
): () => void {
  const url = `/api/traces/${encodeURIComponent(providerId)}/${encodeURIComponent(traceId)}/events`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data && data.type && data.type !== 'connected') {
        onEvent(data as TraceStreamEvent);
      }
    } catch {
      /* ignore malformed payloads */
    }
  };
  return () => es.close();
}
