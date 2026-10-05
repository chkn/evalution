// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { NormalizedPrompt } from "../../../shared/types";
import { PromptRefActions } from "../PromptRefBar";
import { savedVariationPrompt } from "./saved-variation";

const unsavedEdits: NormalizedPrompt = {
  ...savedVariationPrompt,
  variation: {
    ...savedVariationPrompt.variation!,
    wip: true,
    onHead: true,
  },
};

/** The Save / Discard actions shown over unsaved edits, under the given theme. */
export function PromptRefActionsHarness({
  theme,
}: {
  theme: "light" | "dark";
}) {
  return (
    <div data-theme={theme} style={{ padding: 16 }}>
      <PromptRefActions
        shown={unsavedEdits}
        busy={false}
        onSave={() => {}}
        onDiscard={() => {}}
        onSaveAs={() => {}}
      />
    </div>
  );
}
