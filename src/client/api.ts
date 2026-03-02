import type { ParsedPrompt, ModelParameterInfo } from '../shared/types';
import { encodePromptId } from './utils';

export interface ExecuteResult {
  text: string;
  usage: any;
  finishReason: string;
}

function promptUrl(prompt: ParsedPrompt, suffix: string): string {
  return `/api/prompts/${prompt.providerId}/${encodePromptId(prompt.id)}/${suffix}`;
}

async function throwIfError(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
}

export async function getPrompts(): Promise<ParsedPrompt[]> {
  const res = await fetch('/api/prompts');
  await throwIfError(res);
  return res.json();
}

export async function getModelParameters(providerId: string): Promise<ModelParameterInfo[]> {
  const res = await fetch(`/api/providers/${providerId}/model-parameters`);
  await throwIfError(res);
  return res.json();
}

export async function updatePromptProperties(
  prompt: ParsedPrompt,
  updates: Record<string, any>
): Promise<ParsedPrompt> {
  const res = await fetch(promptUrl(prompt, 'update'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  await throwIfError(res);
  return res.json();
}

export async function executePrompt(
  prompt: ParsedPrompt,
  paramValues: Record<string, any>
): Promise<ExecuteResult> {
  const res = await fetch(promptUrl(prompt, 'execute'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream: false,
      functionParams: prompt.functionParameters.map(p => paramValues[p.name]),
    }),
  });
  await throwIfError(res);
  return res.json();
}

export async function* streamPrompt(
  prompt: ParsedPrompt,
  paramValues: Record<string, any>
): AsyncGenerator<string> {
  const res = await fetch(promptUrl(prompt, 'execute'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream: true,
      functionParams: prompt.functionParameters.map(p => paramValues[p.name]),
    }),
  });
  await throwIfError(res);

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        if (data.chunk) yield data.chunk as string;
      }
    }
  }
}
