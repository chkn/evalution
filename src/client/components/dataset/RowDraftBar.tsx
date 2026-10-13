// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

interface Props {
  /** The view the changes came from, by label. */
  viewLabel: string;
  /** The row they're to, as the pane names it. */
  rowName: string;
  /** Set when the stored row changed since: Save is then refused. */
  stale: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * The host's Save/Discard bar under a dataset view's tab, shown while its
 * proposals are pending. A view can't commit its own edits: they land here,
 * and are saved only when the viewer clicks Save. See
 * `specs/dataset-views.md` §D.
 */
export function RowDraftBar({
  viewLabel,
  rowName,
  stale,
  onSave,
  onDiscard,
}: Props) {
  return (
    <div
      className={`row-draft-bar${stale ? " row-draft-bar-stale" : ""}`}
      role="status"
    >
      <span className="row-draft-bar-text">
        {stale
          ? `${rowName} changed since you started editing it in ${viewLabel}. Discard and redo the changes.`
          : `Unsaved changes to ${rowName} from ${viewLabel}`}
      </span>
      <button type="button" className="dialog-btn-cancel" onClick={onDiscard}>
        Discard
      </button>
      <button
        type="button"
        className="dialog-btn-create"
        onClick={onSave}
        disabled={stale}
      >
        Save
      </button>
    </div>
  );
}
