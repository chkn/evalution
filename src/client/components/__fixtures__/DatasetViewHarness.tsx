// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { EvalRun, EvalSummary } from "../../../eval/eval-types";
import type { AgentInfo } from "../../../shared/agent";
import type { NormalizedPrompt } from "../../../shared/types";
import DatasetView from "../DatasetView";
import type { NewEvalSeed } from "../NewEvalDialog";
import type { PanelFill } from "../named-inputs";

/**
 * Mounts DatasetView for one dataset. With `promptName`, the dataset's
 * linked prompt resolves to a loaded prompt of that name; otherwise it isn't
 * loaded; `linkedPrompt` overrides that prompt's details (its parameters and
 * `inputSources`, say). `prompts` are the other loaded prompts: what a new
 * field can copy a parameter's type from, and what the details pane borrows
 * sources from. `evals` are the loaded evals, and `agents` the coding agents
 * "Ask AI" offers.
 *
 * Wrapped in a fixed-height div, as `TraceViewHarness` is: in the app the
 * view's `height: 100%` resolves against the `.app` layout, and without a
 * height here the grid, which fills what's left, would have none.
 */
export function DatasetViewHarness({
  providerId,
  datasetId,
  promptName,
  linkedPrompt,
  prompts,
  onOpenPrompt = () => {},
  onOpenInPlayground = () => {},
  onOpenTrace = () => {},
  onDeleted = () => {},
  onNewEval,
  evals,
  onRunStarted,
  agents,
  onAskAgent,
}: {
  providerId: string;
  datasetId: string;
  promptName?: string;
  linkedPrompt?: Partial<NormalizedPrompt>;
  prompts?: NormalizedPrompt[];
  onOpenPrompt?: (prompt: NormalizedPrompt) => void;
  onOpenInPlayground?: (prompt: NormalizedPrompt, fill: PanelFill) => void;
  onOpenTrace?: (providerId: string, traceId: string) => void;
  onDeleted?: () => void;
  onNewEval?: (seed: NewEvalSeed) => void;
  evals?: EvalSummary[];
  onRunStarted?: (summary: EvalSummary, run: EvalRun) => void;
  agents?: AgentInfo[];
  onAskAgent?: (agent: AgentInfo, rowIds?: readonly string[]) => void;
}) {
  return (
    <div style={{ height: "500px" }}>
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
                ...linkedPrompt,
              } as unknown as NormalizedPrompt)
            : undefined
        }
        prompts={prompts}
        onOpenPrompt={onOpenPrompt}
        onOpenInPlayground={onOpenInPlayground}
        onOpenTrace={onOpenTrace}
        onDeleted={onDeleted}
        onNewEval={onNewEval}
        evals={evals}
        onRunStarted={onRunStarted}
        agents={agents}
        onAskAgent={onAskAgent}
      />
    </div>
  );
}
