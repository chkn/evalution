// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { NormalizedPrompt, PromptRef } from "../../../shared/types";
import { PromptRefChip } from "../PromptRefBar";
import { savedVariationPrompt } from "./saved-variation";

const head: NormalizedPrompt = {
  ...savedVariationPrompt,
  ref: undefined,
  variation: undefined,
};

/**
 * The ref chip over a prompt, showing `initial` (head when omitted). The ref
 * it last switched to is shown in `data-testid="selected"`.
 */
export function PromptRefChipHarness({ initial }: { initial?: PromptRef }) {
  const [selected, setSelected] = useState<PromptRef | undefined>(initial);
  const shown = selected?.variation ? savedVariationPrompt : head;
  return (
    <div style={{ padding: 16 }}>
      <PromptRefChip head={head} shown={shown} onSelect={setSelected} />
      <div data-testid="selected">{selected?.variation ?? "head"}</div>
    </div>
  );
}
