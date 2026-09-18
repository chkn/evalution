// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type {
  NormalizedMessage,
  NormalizedPrompt,
  PropDefinition,
} from "../../../shared/types";
import PlaygroundContent from "../PlaygroundContent";

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
