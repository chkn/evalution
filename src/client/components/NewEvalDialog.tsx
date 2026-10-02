// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type {
  DatasetSummary,
  NormalizedPrompt,
  PromptID,
} from "../../shared/types";
import { createEval } from "../api";
import { datasetKey } from "./DatasetList";

/**
 * The loaded prompt `ref` names: by its `globalId` (what an eval stores, so
 * a move or rename doesn't orphan it) or by its id.
 */
export function findEvalPrompt(
  prompts: readonly NormalizedPrompt[],
  ref: Pick<PromptID, "id" | "providerId"> | undefined,
): NormalizedPrompt | undefined {
  if (!ref) return undefined;
  return (
    prompts.find(p => p.globalId !== undefined && p.globalId === ref.id) ??
    prompts.find(
      p =>
        p.id === ref.id &&
        (ref.providerId === undefined || p.providerId === ref.providerId),
    )
  );
}

/** What "New eval…" was started from, pre-filled in the dialog. */
export interface NewEvalSeed {
  /** The prompt to test — the prompt toolbar's, or a dataset's linked one. */
  prompt?: PromptID;
  /** The dataset to run — the dataset view's. */
  dataset?: { providerId: string; id: string };
}

/**
 * "New eval…": a name, a prompt, and a dataset — all an eval needs to exist.
 * Bindings and checks are added in the editor it opens, which pre-fills the
 * bindings (`specs/evals.md` §F.1).
 */
function NewEvalDialog({
  prompts,
  datasets,
  seed,
  onClose,
  onCreated,
}: {
  prompts: NormalizedPrompt[];
  datasets: DatasetSummary[];
  seed: NewEvalSeed;
  onClose: () => void;
  onCreated: (created: {
    providerId: string;
    id: string;
    name: string;
  }) => void;
}) {
  const promptKey = (p: Pick<PromptID, "id" | "providerId">) =>
    `${p.providerId}:${p.id}`;
  const seededDataset =
    seed.dataset &&
    datasets.find(
      d =>
        d.providerId === seed.dataset!.providerId && d.id === seed.dataset!.id,
    );
  // A dataset's linked prompt, when the dataset is where this started.
  const seededPrompt = findEvalPrompt(
    prompts,
    seed.prompt ?? seededDataset?.prompt,
  );

  const [name, setName] = useState(
    seededPrompt && seededDataset
      ? `${seededPrompt.name} on ${seededDataset.name}`
      : "",
  );
  const [promptChoice, setPromptChoice] = useState(
    seededPrompt ? promptKey(seededPrompt) : "",
  );
  const [datasetChoice, setDatasetChoice] = useState(
    seededDataset ? datasetKey(seededDataset) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prompt = prompts.find(p => promptKey(p) === promptChoice);
  const dataset = datasets.find(d => datasetKey(d) === datasetChoice);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt?.providerId || !dataset || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createEval({
        name: name.trim(),
        // The prompt's global id when it has one, so a move or rename
        // doesn't orphan the eval.
        prompt: {
          id: prompt.globalId ?? prompt.id,
          providerId: prompt.providerId,
        },
        dataset: { providerId: dataset.providerId, id: dataset.id },
        inputs: { functionInputs: {}, executeInputs: {} },
        checks: [],
      });
      onCreated(created);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={e => e.target === e.currentTarget && onClose()}
    >
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-header">
          <h3>New eval</h3>
          <button
            type="button"
            className="dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          {error && <div className="dialog-error">{error}</div>}
          <div className="dialog-field">
            <label htmlFor="new-eval-name">Name</label>
            <input
              id="new-eval-name"
              autoFocus
              value={name}
              placeholder="Plans the right tasks"
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div className="dialog-field">
            <label htmlFor="new-eval-prompt">Prompt</label>
            <select
              id="new-eval-prompt"
              value={promptChoice}
              onChange={e => setPromptChoice(e.target.value)}
            >
              <option value="">Choose a prompt…</option>
              {prompts.map(p => (
                <option key={promptKey(p)} value={promptKey(p)}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="dialog-field">
            <label htmlFor="new-eval-dataset">Dataset</label>
            <select
              id="new-eval-dataset"
              value={datasetChoice}
              onChange={e => setDatasetChoice(e.target.value)}
            >
              <option value="">Choose a dataset…</option>
              {datasets.map(d => (
                <option key={datasetKey(d)} value={datasetKey(d)}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-btn-cancel"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="dialog-btn-create"
              disabled={busy || !prompt || !dataset || !name.trim()}
            >
              Create
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default NewEvalDialog;
