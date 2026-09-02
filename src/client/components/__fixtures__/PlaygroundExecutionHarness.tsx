// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { NormalizedPrompt, PropDefinition } from "../../../shared/types";
import PlaygroundExecution from "../PlaygroundExecution";

function makePrompt(
  functionParameters: PropDefinition[],
  id = "test",
): NormalizedPrompt {
  return {
    id,
    providerId: "test",
    name: "test",
    functionParameters,
    modelEditable: true,
    systemEditable: true,
    messages: [],
    messagesEditable: true,
    modelParameters: [],
  };
}

/**
 * Mounts PlaygroundExecution with a single parameter whose default value is
 * an unmaterializable `raw` fallback (the JSON-fallback editor's escape hatch
 * for expressions ts-proppy couldn't parse into a structured PropValue).
 */
export function PlaygroundExecutionRawParamHarness({
  sourceText,
}: {
  sourceText: string;
}) {
  const prompt = makePrompt([
    {
      name: "config",
      type: { kind: "primitive", syntax: "unknown" },
      optional: false,
      defaultValue: { kind: "raw", sourceText },
    },
  ]);
  return <PlaygroundExecution prompt={prompt} />;
}

/** Mounts PlaygroundExecution with the given function parameters. */
export function PlaygroundExecutionHarness({
  functionParameters,
  promptId,
}: {
  functionParameters: PropDefinition[];
  /** Overrides the mounted prompt's `id`, for testing per-prompt storage keys. */
  promptId?: string;
}) {
  return (
    <PlaygroundExecution prompt={makePrompt(functionParameters, promptId)} />
  );
}
