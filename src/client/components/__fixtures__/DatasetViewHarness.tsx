// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { NormalizedPrompt } from "../../../shared/types";
import DatasetView from "../DatasetView";

/**
 * Mounts DatasetView for one dataset. With `promptName`, the dataset's
 * linked prompt resolves to a loaded prompt of that name; otherwise no
 * prompts are loaded.
 */
export function DatasetViewHarness({
  providerId,
  datasetId,
  promptName,
  onOpenPrompt = () => {},
  onDeleted = () => {},
}: {
  providerId: string;
  datasetId: string;
  promptName?: string;
  onOpenPrompt?: (prompt: NormalizedPrompt) => void;
  onDeleted?: () => void;
}) {
  return (
    <DatasetView
      providerId={providerId}
      datasetId={datasetId}
      version={0}
      findPrompt={prompt =>
        promptName
          ? ({
              ...prompt,
              name: promptName,
              functionParameters: [],
            } as unknown as NormalizedPrompt)
          : undefined
      }
      onOpenPrompt={onOpenPrompt}
      onOpenInPlayground={() => {}}
      onOpenTrace={() => {}}
      onDeleted={onDeleted}
    />
  );
}
