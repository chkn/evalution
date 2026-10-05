// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type {
  NormalizedMessage,
  NormalizedPrompt,
  PromptRef,
  PropDefinition,
} from "../../../shared/types";
import PlaygroundContent from "../PlaygroundContent";
import { SAVED_VARIATION_ID } from "./saved-variation";

function makePrompt(
  messagesCount: number,
  functionParameters: PropDefinition[],
): NormalizedPrompt {
  const messages: NormalizedMessage[] = Array.from(
    { length: messagesCount },
    (_, i) => ({
      role: "user",
      content: {
        kind: "primitive",
        value: `Message ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
      },
    }),
  );
  return {
    id: "test",
    providerId: "test",
    name: "test",
    functionParameters,
    style: "chat",
    modelEditable: true,
    systemEditable: true,
    messages,
    messagesEditable: true,
    modelParameters: [],
  };
}

/**
 * Mounts PlaygroundContent inside a fixed-size `.main-content` so tests can
 * assert the single-vs-multi-column layout switch at controlled dimensions.
 */
export function PlaygroundContentHarness({
  width,
  height,
  messagesCount,
  functionParameters = [],
}: {
  width: number;
  height: number;
  messagesCount: number;
  functionParameters?: PropDefinition[];
}) {
  const [prompt, setPrompt] = useState<NormalizedPrompt>(
    makePrompt(messagesCount, functionParameters),
  );
  return (
    <div className="main-content" style={{ width, height }}>
      <PlaygroundContent
        prompt={prompt}
        onUpdate={setPrompt}
        onDirtyChange={() => {}}
      />
    </div>
  );
}

/** Mounts PlaygroundContent showing a saved variation of a versioned prompt. */
export function SavedVariationHarness() {
  const [prompt, setPrompt] = useState<NormalizedPrompt>({
    ...makePrompt(1, []),
    ref: { promptId: "test" },
    atHead: true,
  });
  return (
    <div className="main-content" style={{ width: 900, height: 500 }}>
      <PlaygroundContent
        prompt={prompt}
        promptRef={{ promptId: "test", variation: SAVED_VARIATION_ID }}
        onUpdate={setPrompt}
        onDirtyChange={() => {}}
      />
    </div>
  );
}

/**
 * Mounts PlaygroundContent on a versioned prompt opened at `version`, and
 * shows which version the tab is on after the ref changes.
 */
export function VersionRefHarness({ version }: { version: string }) {
  const [prompt, setPrompt] = useState<NormalizedPrompt>({
    ...makePrompt(1, []),
    ref: { promptId: "test" },
    atHead: true,
  });
  const [promptRef, setPromptRef] = useState<PromptRef | undefined>({
    promptId: "test",
    version,
  });
  return (
    <div className="main-content" style={{ width: 900, height: 500 }}>
      <output data-testid="tab-ref">{promptRef?.version ?? "head"}</output>
      <PlaygroundContent
        prompt={prompt}
        promptRef={promptRef}
        onRefChange={setPromptRef}
        onUpdate={setPrompt}
        onDirtyChange={() => {}}
      />
    </div>
  );
}
