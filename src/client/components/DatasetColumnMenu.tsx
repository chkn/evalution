// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Rectangle } from "@glideapps/glide-data-grid";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { DatasetField } from "../../shared/types";
import { useAnchoredPopover } from "./use-anchored-popover";

interface Props {
  /** The field the menu is for. */
  field: DatasetField;
  /** The column header's place on screen, which the menu opens below. */
  anchor: Rectangle;
  /**
   * Renames the field. A rejection (a duplicate name, say) is shown in the
   * menu, which stays open; once it resolves the menu closes.
   */
  onRename: (name: string) => Promise<void>;
  /** The field is to be deleted; the caller confirms, then closes the menu. */
  onDelete: () => void;
  /** Called when the menu is dismissed or has done its job. */
  onClose: () => void;
}

/**
 * The menu a dataset grid's column header opens: rename the field, or delete
 * it. Renaming swaps the menu for a name box in place. Placed against `anchor`
 * — the header cell's rectangle, which Glide reports but draws on a canvas —
 * through an invisible fixed element standing in for a trigger.
 */
export function DatasetColumnMenu({
  field,
  anchor,
  onRename,
  onDelete,
  onClose,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(field.def.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { triggerRef, popoverRef, style } = useAnchoredPopover<HTMLSpanElement>(
    { open: true, onClose, matchTriggerWidth: false },
  );

  const submit = async () => {
    const trimmed = name.trim();
    if (busy) return;
    if (!trimmed || trimmed === field.def.name) return onClose();
    setBusy(true);
    try {
      await onRename(trimmed);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <span
        ref={triggerRef}
        aria-hidden
        style={{
          position: "fixed",
          left: anchor.x,
          top: anchor.y,
          width: anchor.width,
          height: anchor.height,
          pointerEvents: "none",
        }}
      />
      {renaming ? (
        <div
          className="dataset-add-field"
          ref={popoverRef}
          style={style}
          role="dialog"
          aria-label="Rename field"
        >
          <form
            onSubmit={e => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              autoFocus
              data-1p-ignore
              className="add-to-dataset-name"
              aria-label="Field name"
              value={name}
              onChange={e => {
                setName(e.target.value);
                setError(null);
              }}
              onFocus={e => e.target.select()}
            />
            {error && (
              <div className="dataset-add-field-error" role="alert">
                {error}
              </div>
            )}
            <div className="dataset-add-field-actions">
              <button
                type="submit"
                className="add-to-dataset-create"
                disabled={!name.trim() || busy}
              >
                Rename
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div
          className="trace-header-menu"
          ref={popoverRef}
          style={style}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="trace-header-menu-item"
            onClick={() => setRenaming(true)}
          >
            <span className="trace-header-menu-item-label">Rename field…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="trace-header-menu-item dataset-menu-delete"
            onClick={onDelete}
          >
            <span className="trace-header-menu-item-label">Delete field</span>
          </button>
        </div>
      )}
    </>,
    document.body,
  );
}
