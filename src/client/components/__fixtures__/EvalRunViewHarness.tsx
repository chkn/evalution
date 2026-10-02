// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { EvalRunProgress } from "../../../eval/eval-types";
import EvalRunView from "../EvalRunView";

/** Mounts EvalRunView for one run, in a fixed-size pane like `EvalViewHarness`. */
export function EvalRunViewHarness({
  providerId,
  runId,
  progress,
  onDeleted = () => {},
}: {
  providerId: string;
  runId: string;
  progress?: EvalRunProgress;
  onDeleted?: () => void;
}) {
  return (
    <div style={{ width: 900, height: 600 }}>
      <EvalRunView
        providerId={providerId}
        runId={runId}
        version={0}
        {...(progress && { progress })}
        onOpenTrace={() => {}}
        onDeleted={onDeleted}
      />
    </div>
  );
}
