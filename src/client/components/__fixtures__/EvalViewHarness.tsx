// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { DatasetSummary, NormalizedPrompt } from "../../../shared/types";
import EvalView from "../EvalView";

/**
 * Mounts EvalView for one eval, with `prompts` and `datasets` loaded. Wrapped
 * in a fixed-height div, as `DatasetViewHarness` is, since the view fills its
 * pane's height.
 */
export function EvalViewHarness({
  providerId,
  evalId,
  prompts,
  datasets,
}: {
  providerId: string;
  evalId: string;
  prompts: NormalizedPrompt[];
  datasets: DatasetSummary[];
}) {
  return (
    <div style={{ height: "700px" }}>
      <EvalView
        providerId={providerId}
        evalId={evalId}
        prompts={prompts}
        datasets={datasets}
        version={0}
        datasetVersion={0}
        progress={{}}
        onOpenRun={() => {}}
        onOpenPrompt={() => {}}
        onOpenDataset={() => {}}
        onDeleted={() => {}}
      />
    </div>
  );
}
