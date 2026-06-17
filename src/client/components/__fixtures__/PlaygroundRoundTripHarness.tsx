// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type {
  NormalizedMessage,
  NormalizedPrompt,
  PropValue,
} from "../../../shared/types";
import PlaygroundContent from "../PlaygroundContent";

/**
 * Mounts the real {@link PlaygroundContent} (which performs genuine save
 * round-trips through `../api`). Tests pair this with `page.route` to mock the
 * `/api/**` endpoints, so the full optimistic-update + round-trip path runs
 * exactly as it does in the app.
 */
export function PlaygroundRoundTripHarness({
  initialMessages = [],
  initialSystem,
}: {
  initialMessages?: NormalizedMessage[];
  initialSystem?: PropValue;
} = {}) {
  const [prompt, setPrompt] = useState<NormalizedPrompt>({
    id: "p1",
    providerId: "prov",
    name: "test",
    functionParameters: [],
    modelEditable: true,
    systemEditable: true,
    messages: initialMessages,
    messagesEditable: true,
    modelParameters: [],
    ...(initialSystem !== undefined ? { system: initialSystem } : {}),
  });
  return (
    <div className="main-content" style={{ width: 900, height: 600 }}>
      <PlaygroundContent
        prompt={prompt}
        onUpdate={setPrompt}
        onDirtyChange={() => {}}
      />
    </div>
  );
}
