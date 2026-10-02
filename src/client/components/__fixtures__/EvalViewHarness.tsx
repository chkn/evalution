// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { EvalRunSummary } from "../../../eval/eval-types";
import type { DatasetSummary, NormalizedPrompt } from "../../../shared/types";
import EvalView from "../EvalView";

/**
 * Mounts EvalView for one eval, with `prompts` and `datasets` loaded. Wrapped
 * in a fixed-size div, as `PlaygroundContentHarness` is: the view fills its
 * pane, and its layout answers to the pane's width.
 */
export function EvalViewHarness({
  providerId,
  evalId,
  prompts,
  datasets,
  width = 900,
  height = 700,
  onOpenRun = () => {},
  onRunDeleted = () => {},
}: {
  providerId: string;
  evalId: string;
  prompts: NormalizedPrompt[];
  datasets: DatasetSummary[];
  /** The pane's size: what the layout answers to, as in `PlaygroundContentHarness`. */
  width?: number;
  height?: number;
  onOpenRun?: (run: EvalRunSummary) => void;
  onRunDeleted?: (run: EvalRunSummary) => void;
}) {
  return (
    <div style={{ width, height }}>
      <EvalView
        providerId={providerId}
        evalId={evalId}
        prompts={prompts}
        datasets={datasets}
        version={0}
        datasetVersion={0}
        progress={{}}
        onOpenRun={onOpenRun}
        onOpenPrompt={() => {}}
        onOpenDataset={() => {}}
        onDeleted={() => {}}
        onRunDeleted={onRunDeleted}
      />
    </div>
  );
}
