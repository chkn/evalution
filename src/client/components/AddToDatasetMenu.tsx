// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { samePrompt } from "../../shared/dataset-fields";
import type {
  DatasetField,
  DatasetRowSource,
  DatasetSummary,
  PromptID,
  RunResources,
} from "../../shared/types";
import {
  addDatasetRows,
  createDataset,
  getDatasetProviders,
  getDatasets,
} from "../api";
import {
  countMatches,
  type NamedInputs,
  rowResources,
  type SkippedInput,
  toCells,
} from "./named-inputs";
import { DatasetsIcon } from "./trace/icons.tsx";
import { useAnchoredPopover } from "./use-anchored-popover";

interface Props {
  /** What would be added — one row's worth. */
  inputs: NamedInputs;
  /** The resource instances `inputs` may reference, kept on the row. */
  resources?: RunResources;
  /** The schema "New dataset…" creates. */
  newDatasetFields: Omit<DatasetField, "id">[];
  /**
   * The prompt these inputs are for, if any. `link` is stored on a new
   * dataset (prefer the prompt's `globalId`, which survives moves);
   * `openable` is what a linked dataset's resolved `prompt` is compared
   * against to list it first.
   */
  prompt?: { link: PromptID; openable: PromptID };
  /** Recorded on the row, so the dataset view can link back. */
  source: DatasetRowSource;
  /** Disables the trigger — e.g. when every slot is empty. */
  disabled?: boolean;
  /** Class for the trigger, to match its surroundings. */
  className?: string;
  /** The trigger's content, when not the default icon and label. */
  children?: ReactNode;
}

/**
 * Whether `target` is inside an open add-to-dataset menu — for a surrounding
 * popover (the trace header's collapsed menu) that must not close when the
 * menu it contains is clicked.
 */
export function isInAddToDatasetMenu(target: Node): boolean {
  return target instanceof Element && !!target.closest(".add-to-dataset-menu");
}

/** What the last add did, shown beside the trigger until the next one. */
interface Outcome {
  ok: boolean;
  message: string;
}

/** How long a success note stays beside the trigger. */
const OUTCOME_MS = 6000;

function describeSkipped(skipped: SkippedInput[]): string {
  if (skipped.length === 0) return "";
  const names = [...new Set(skipped.map(s => s.name))];
  return ` · skipped ${names.join(", ")} (no matching field)`;
}

/**
 * "Add to dataset": a button that opens a menu of every dataset — those
 * linked to this prompt first, each saying how much of `inputs` would land,
 * a dataset with nothing to take shown disabled rather than hidden — plus
 * "New dataset…", which creates one from `newDatasetFields` and adds the row.
 * See `specs/datasets.md` §J.
 */
export function AddToDatasetMenu({
  inputs,
  resources,
  newDatasetFields,
  prompt,
  source,
  disabled,
  className,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setCreating(false);
    setNewName("");
  }, []);

  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
    });

  // Fetched on every open rather than kept in sync: the menu is short-lived,
  // and a fresh list can't be stale.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    Promise.all([getDatasets(), getDatasetProviders()])
      .then(([list, providers]) => {
        if (cancelled) return;
        setDatasets(list);
        setProviderId(providers[0]?.id ?? null);
      })
      .catch(err => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (creating) nameRef.current?.focus();
  }, [creating]);

  // A success note clears itself; an error stays until dismissed.
  useEffect(() => {
    if (!outcome?.ok) return;
    const timer = setTimeout(() => setOutcome(null), OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const addTo = async (
    target: { providerId: string; id: string; name: string },
    fields: readonly DatasetField[],
  ) => {
    const { cells, skipped } = toCells(inputs, fields);
    const kept = rowResources(resources);
    await addDatasetRows(target.providerId, target.id, [
      { cells, source, ...(kept && { resources: kept }) },
    ]);
    setOutcome({
      ok: true,
      message: `Added to ${target.name}${describeSkipped(skipped)}`,
    });
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      close();
    } catch (err: any) {
      setOutcome({ ok: false, message: err.message });
      close();
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = () =>
    run(async () => {
      const name = newName.trim();
      if (!name || !providerId) return;
      const created = await createDataset(providerId, {
        name,
        fields: newDatasetFields,
        ...(prompt && { prompt: prompt.link }),
      });
      await addTo({ ...created, providerId }, created.fields);
    });

  const sorted = [...(datasets ?? [])].sort((a, b) => {
    const aLinked = samePrompt(a.prompt, prompt?.openable);
    const bLinked = samePrompt(b.prompt, prompt?.openable);
    return aLinked === bLinked ? 0 : aLinked ? -1 : 1;
  });

  const menu =
    open &&
    createPortal(
      <div
        className="add-to-dataset-menu"
        ref={popoverRef}
        style={style}
        role="menu"
      >
        {loadError && <div className="add-to-dataset-error">{loadError}</div>}
        {!datasets && !loadError && (
          <div className="add-to-dataset-empty">Loading…</div>
        )}
        {sorted.map(dataset => {
          const matched = dataset.error
            ? 0
            : countMatches(inputs, dataset.fields);
          const linked = samePrompt(dataset.prompt, prompt?.openable);
          return (
            <button
              key={`${dataset.providerId}:${dataset.id}`}
              type="button"
              role="menuitem"
              className="add-to-dataset-item"
              disabled={busy || matched === 0}
              onClick={() => run(() => addTo(dataset, dataset.fields))}
              title={dataset.error ?? undefined}
            >
              <span className="add-to-dataset-item-name">
                {dataset.name}
                {linked && (
                  <span className="add-to-dataset-linked">linked</span>
                )}
              </span>
              <span className="add-to-dataset-item-meta">
                {dataset.error
                  ? "can't be opened"
                  : matched === 0
                    ? "no matching fields"
                    : `${matched} of ${inputs.length} field${inputs.length === 1 ? "" : "s"}`}
              </span>
            </button>
          );
        })}
        {datasets && sorted.length > 0 && (
          <div className="add-to-dataset-divider" />
        )}
        {creating ? (
          <form
            className="add-to-dataset-new"
            onSubmit={e => {
              e.preventDefault();
              void createAndAdd();
            }}
          >
            <input
              ref={nameRef}
              className="add-to-dataset-name"
              placeholder="Dataset name"
              aria-label="New dataset name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              disabled={busy}
            />
            <button
              type="submit"
              className="add-to-dataset-create"
              disabled={busy || !newName.trim() || !providerId}
            >
              Create
            </button>
          </form>
        ) : (
          <button
            type="button"
            role="menuitem"
            className="add-to-dataset-item add-to-dataset-item-new"
            onClick={() => setCreating(true)}
            disabled={busy || (!!datasets && !providerId)}
          >
            <span className="add-to-dataset-item-name">New dataset…</span>
          </button>
        )}
      </div>,
      document.body,
    );

  return (
    <span className="add-to-dataset">
      {outcome && (
        <span
          className={`add-to-dataset-outcome${outcome.ok ? "" : " add-to-dataset-outcome-error"}`}
          role="status"
          title={outcome.message}
        >
          {outcome.message}
          <button
            type="button"
            className="pg-dismiss"
            aria-label="Dismiss"
            onClick={() => setOutcome(null)}
          >
            ×
          </button>
        </span>
      )}
      <button
        type="button"
        ref={triggerRef}
        className={className ?? "add-to-dataset-btn"}
        onClick={() => {
          setOutcome(null);
          setOpen(o => !o);
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add these inputs to a dataset"
      >
        {children ?? (
          <>
            <DatasetsIcon />
            Add to dataset
          </>
        )}
      </button>
      {menu}
    </span>
  );
}
