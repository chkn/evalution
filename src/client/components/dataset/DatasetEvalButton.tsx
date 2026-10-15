// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { createPortal } from "react-dom";
import type { EvalSummary } from "../../../eval/eval-types";
import { ChevronDownIcon, EvalsIcon } from "../trace/icons";
import { useAnchoredPopover } from "../use-anchored-popover";

interface Props {
  /** The evals over the dataset, each offered as a "Run" item. */
  evals: readonly EvalSummary[];
  /**
   * How many rows are selected: the runs are then of those rows alone. Zero
   * runs every row.
   */
  selectedRows: number;
  /** Runs `summary` — on the selected rows, when there are any. */
  onRun: (summary: EvalSummary) => void;
  /** "New eval…": opens the dialog with the dataset chosen. */
  onNewEval?: () => void;
}

/**
 * A dataset's "Evals" button: drops down a "Run" item per eval over the
 * dataset, then, past a separator, "New eval…".
 */
export function DatasetEvalButton(props: Props) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
    });

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="trace-view-prompt-btn dataset-eval-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Run an eval on this dataset, or set up a new one"
      >
        <EvalsIcon size={14} />
        Evals
        <ChevronDownIcon />
      </button>
      {open &&
        createPortal(
          <div
            className="trace-header-menu"
            ref={popoverRef}
            style={style}
            role="menu"
          >
            <DatasetEvalMenuItems {...props} onChosen={close} />
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The entries of {@link DatasetEvalButton}'s menu — and of a header's
 * collapsed "More actions" menu, where they stand in for the button: a "Run"
 * item per eval, then "New eval…", divided from them when there are any.
 */
export function DatasetEvalMenuItems({
  evals,
  selectedRows,
  onRun,
  onNewEval,
  onChosen,
}: Props & {
  /** Called as an item is chosen, before it acts: closes the menu. */
  onChosen: () => void;
}) {
  const on =
    selectedRows > 0
      ? ` on ${selectedRows} row${selectedRows === 1 ? "" : "s"}`
      : "";
  return (
    <>
      {evals.map(summary => (
        <button
          key={`${summary.providerId}/${summary.id}`}
          type="button"
          role="menuitem"
          className="trace-header-menu-item"
          onClick={() => {
            onChosen();
            onRun(summary);
          }}
        >
          <span className="trace-header-menu-item-icon">▶</span>
          <span className="trace-header-menu-item-label">
            Run {summary.name}
            {on}
          </span>
        </button>
      ))}
      {onNewEval && (
        <>
          {evals.length > 0 && <hr className="ask-agent-menu-divider" />}
          <button
            type="button"
            role="menuitem"
            className="trace-header-menu-item"
            onClick={() => {
              onChosen();
              onNewEval();
            }}
          >
            <span className="trace-header-menu-item-icon">
              <EvalsIcon size={14} />
            </span>
            <span className="trace-header-menu-item-label">New eval…</span>
          </button>
        </>
      )}
    </>
  );
}
