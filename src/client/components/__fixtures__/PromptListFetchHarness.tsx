// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { usePrompts } from "../../hooks/usePrompts";
import PromptList from "../PromptList";

/**
 * Mounts PromptList wired to `usePrompts` the way `App.tsx` is, with a button
 * standing in for the SSE-triggered refetch. Tests stub `/api/prompts`.
 */
export function PromptListFetchHarness() {
  const { prompts, loading, error, refetch } = usePrompts();
  return (
    <div>
      <button type="button" onClick={refetch}>
        Refetch
      </button>
      <PromptList
        prompts={prompts}
        selectedId={null}
        onSelect={() => {}}
        loading={loading}
        error={error}
      />
    </div>
  );
}
