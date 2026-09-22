// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  NormalizedChatPrompt,
  NormalizedPrompt,
  PromptInputSources,
  PropDefinition,
} from "../../../shared/types";
import type { PanelFill, PanelFillSource } from "../named-inputs";
import PlaygroundExecution from "../PlaygroundExecution";

function makePrompt(
  functionParameters: PropDefinition[],
  id = "test",
  extra: Partial<NormalizedChatPrompt> = {},
): NormalizedPrompt {
  return {
    id,
    providerId: "test",
    name: "test",
    functionParameters,
    style: "chat",
    modelEditable: true,
    systemEditable: true,
    messages: [],
    messagesEditable: true,
    modelParameters: [],
    ...extra,
  };
}

/** Mounts PlaygroundExecution with the given function parameters. */
export function PlaygroundExecutionHarness({
  functionParameters,
  promptId,
  executeParameters,
  inputSources,
  fill,
  onOpenFillSource,
}: {
  functionParameters: PropDefinition[];
  /** Overrides the mounted prompt's `id`, for testing per-prompt storage keys. */
  promptId?: string;
  /** Values the SDK needs at run time, rendered in their own section. */
  executeParameters?: PropDefinition[];
  /** Resources the provider offers, and which slots they fit. */
  inputSources?: PromptInputSources;
  /** A one-shot request to overwrite the panel, as a trace or dataset row sends. */
  fill?: PanelFill;
  /** Opens where a fill came from; without it the notice's source is plain text. */
  onOpenFillSource?: (from: PanelFillSource) => void;
}) {
  return (
    <PlaygroundExecution
      prompt={makePrompt(functionParameters, promptId, {
        ...(executeParameters ? { executeParameters } : {}),
        ...(inputSources ? { inputSources } : {}),
      })}
      fill={fill}
      onOpenFillSource={onOpenFillSource}
    />
  );
}
