// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { NormalizedPrompt } from "../../../shared/types";
import { DatasetAddColumn } from "../DatasetAddColumn";

const PROMPT = {
  id: "plan.ts#plan",
  providerId: "test",
  name: "plan",
  style: "chat",
  functionParameters: [
    {
      name: "threadMessages",
      optional: false,
      type: {
        kind: "primitive",
        syntax: 'readonly Pick<ThreadMessage, "excerpt" | "author">[]',
      },
    },
  ],
} as unknown as NormalizedPrompt;

/**
 * A "＋" pinned to the window's right edge, as the dataset grid's is when its
 * columns fill the view, with a parameter whose long type widens the New
 * field form past the menu it replaces.
 */
export function DatasetAddColumnHarness() {
  return (
    <div style={{ position: "fixed", top: 0, right: 0 }}>
      <DatasetAddColumn
        fields={[]}
        instances={{}}
        describePath={async () => []}
        onPick={() => {}}
        onFieldAdded={() => {}}
        newField={{
          providerId: "test",
          datasetId: "d",
          prompts: [PROMPT],
        }}
        top={0}
        height={32}
      />
    </div>
  );
}
