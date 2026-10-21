// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { NormalizedPrompt } from "../../../shared/types";
import PlaygroundContent from "../PlaygroundContent";

/**
 * Mounts {@link PlaygroundContent} on a versioned prompt at head with no
 * unsaved edits yet — so its first edit has no variation to land in — with a
 * model already set. Tests pair this with `page.route` to mock `/api/**`.
 */
export function FirstEditHarness() {
  const [prompt, setPrompt] = useState<NormalizedPrompt>({
    id: "p1",
    providerId: "prov",
    name: "test",
    functionParameters: [],
    style: "chat",
    modelEditable: true,
    systemEditable: true,
    model: { kind: "primitive", value: "openai/gpt-5.5" },
    messages: [],
    messagesEditable: true,
    modelParameters: [],
    ref: { promptId: "p1" },
    atHead: true,
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
