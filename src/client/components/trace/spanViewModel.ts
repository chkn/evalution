// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  Span,
  SpanKind,
  SpanMessage,
  ToolSpanDetails,
} from "../../../shared/types";

/** A `Span`, reshaped for the trace UI components. */
export interface SpanViewModel {
  id: string;
  parentId?: string;
  name: string;
  spanType: SpanKind;
  /** Start timestamp (ms). */
  startMs: number;
  /** End timestamp (ms), or `undefined` while still running. */
  endMs?: number;
  /** `endMs - startMs`, or `undefined` while still running. */
  durationMs?: number;
  status?: "ok" | "error";
  errorMessage?: string;
  /** Free-form attributes; `undefined` for a native-telemetry span (no OTel attribute bag at all). */
  attributes?: Record<string, unknown>;

  // -- LLM (present only for `spanType: 'LLM'`, and only when known) --
  provider?: string;
  model?: string;
  messages?: SpanMessage[];
  output?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  modelParameters?: Record<string, unknown>;

  // -- Tool (present only for `spanType: 'TOOL'`) --
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;

  // -- Prompt link --
  promptId?: string;
  promptProviderId?: string;
}

function toolFields(
  tool: ToolSpanDetails | undefined,
): Pick<SpanViewModel, "toolName" | "toolArgs" | "toolResult"> {
  if (!tool) return {};
  return {
    toolName: tool.toolName,
    toolArgs: tool.input,
    toolResult: tool.output,
  };
}

/** Converts a `Span` into a {@link SpanViewModel}. */
export function toSpanViewModel(span: Span): SpanViewModel {
  const { llm, tool, prompt } = span;
  return {
    id: span.id,
    parentId: span.parentId,
    name: span.name,
    spanType: span.kind,
    startMs: span.startTime,
    endMs: span.endTime,
    durationMs:
      span.endTime !== undefined ? span.endTime - span.startTime : undefined,
    status: span.status,
    errorMessage: span.errorMessage,
    attributes: span.attributes,

    ...(llm && {
      provider: llm.provider,
      model: llm.model,
      messages: llm.messages,
      output: llm.output,
      promptTokens: llm.promptTokens,
      completionTokens: llm.completionTokens,
      totalTokens: llm.totalTokens,
      cost: llm.cost,
      modelParameters: llm.modelParameters,
    }),
    ...toolFields(tool),
    ...(prompt && { promptId: prompt.id, promptProviderId: prompt.providerId }),
  };
}
