// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { createPortal } from "react-dom";
import { type ColumnPath, columnPathId } from "../../shared/column-paths";
import type {
  DatasetField,
  DatasetPathChild,
  DatasetRowsOverview,
} from "../../shared/types";
import { AddColumnMenu, type NewFieldConfig } from "./DatasetAddColumn";
import {
  type ColumnLayout,
  type LayoutColumn,
  type LayoutSlot,
  moveColumn,
  moveKey,
  setHidden,
  slotPath,
} from "./dataset-columns";
import { addedTitle, pathLabel } from "./dataset-grid";
import {
  ChevronDownIcon,
  ColumnsIcon,
  GrabHandleIcon,
} from "./trace/icons.tsx";
import { useAnchoredPopover } from "./use-anchored-popover";

interface Props {
  /** The reconciled layout ({@link reconcileColumns}). */
  layout: ColumnLayout;
  fields: readonly DatasetField[];
  /** The rows' resource instances, offered as roots by "Add column…". */
  instances: DatasetRowsOverview["instances"];
  /** The path that names a row, if any. */
  rowLabel: ColumnPath | undefined;
  /** Writes a changed layout. A drag writes once, on drop. */
  onChange: (layout: ColumnLayout) => void;
  /** Sets the row label, or clears it with `undefined`. */
  onRowLabel: (path: ColumnPath | undefined) => void;
  /** Adds a column at `path`. */
  onAdd: (path: ColumnPath) => void;
  /**
   * Removes the added column at `index` — and the row label with it, if
   * that column was the label, since no menu would be left to clear it.
   */
  onRemove: (index: number) => void;
  /** The keys one level inside a path, for "Add column…"'s tree. */
  describePath: (path: ColumnPath) => Promise<DatasetPathChild[]>;
  /** What "New field" in "Add column…" needs to add a field. */
  newField: NewFieldConfig;
  /** Called once "New field" has added one. */
  onFieldAdded: () => void;
}

/** A slot as one string, to compare and key rows by. */
const slotKey = (slot: LayoutSlot) =>
  slot.key === undefined ? `${slot.index}` : `${slot.index}/${slot.key}`;

/**
 * The dataset view's "Columns" button and its popover: one row per column,
 * in the layout's order, each with a grab handle, a checkbox that hides or
 * shows it, and its title. A field with keys discloses them as indented
 * rows, which reorder only within that field; an added column's row has a
 * ✕ that removes it; and each path's overflow menu sets the row label.
 * "Add column…" at the bottom browses the rows' paths as a tree, with "New
 * field…" below it. Reordering is a live swap off the grab handle, as the
 * trace list's picker does, but written once, when the drag ends. See
 * `specs/datasets.md` §Q.3.
 */
export function DatasetColumnPicker({
  layout,
  fields,
  instances,
  rowLabel,
  onChange,
  onRowLabel,
  onAdd,
  onRemove,
  describePath,
  newField,
  onFieldAdded,
}: Props) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  /** The layout as a drag in progress has it; written when the drag ends. */
  const [draft, setDraft] = useState<ColumnLayout | null>(null);
  const [drag, setDrag] = useState<LayoutSlot | null>(null);
  /** Fields whose keys are disclosed, by id. */
  const [disclosed, setDisclosed] = useState<ReadonlySet<string>>(new Set());
  /** The row whose overflow menu is open. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setAdding(false);
    setMenuFor(null);
  };
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
    });

  const shown = draft ?? layout;
  const labelId = rowLabel && columnPathId(rowLabel);
  const fieldName = (id: string) =>
    fields.find(f => f.id === id)?.def.name ?? id;

  const dragOver = (target: LayoutSlot) => {
    if (!drag || !draft) return false;
    if (drag.key === undefined && target.key === undefined) {
      if (target.index !== drag.index) {
        setDraft(moveColumn(draft, drag.index, target.index));
        setDrag({ index: target.index });
      }
      return true;
    }
    // A key moves only within its own field.
    const entry = draft[drag.index];
    if (
      drag.key === undefined ||
      target.key === undefined ||
      target.index !== drag.index ||
      entry?.kind !== "field"
    ) {
      return false;
    }
    if (target.key !== drag.key) {
      const from = entry.keys.findIndex(k => k.key === drag.key);
      const to = entry.keys.findIndex(k => k.key === target.key);
      setDraft(moveKey(draft, drag.index, from, to));
    }
    return true;
  };

  const endDrag = () => {
    if (draft && draft !== layout) onChange(draft);
    setDraft(null);
    setDrag(null);
  };

  const pickerRow = ({
    slot,
    title,
    detail,
    hidden,
    removable,
    disclosure,
    dim,
  }: {
    slot: LayoutSlot;
    title: string;
    /** Dimmed beside the title. */
    detail?: string;
    hidden: boolean;
    removable?: boolean;
    disclosure?: { open: boolean; toggle: () => void };
    dim?: boolean;
  }) => {
    const key = slotKey(slot);
    const path = slotPath(shown, slot);
    const isLabel = !!path && columnPathId(path) === labelId;
    return (
      <div
        key={key}
        className={`trace-column-picker-row dataset-column-picker-row${
          slot.key !== undefined ? " dataset-column-picker-key" : ""
        }${drag && slotKey(drag) === key ? " trace-column-picker-row-dragging" : ""}${
          dim ? " dataset-column-picker-dim" : ""
        }`}
        onDragOver={e => {
          if (dragOver(slot)) e.preventDefault();
        }}
        onDrop={e => e.preventDefault()}
      >
        <span
          className="trace-column-picker-grab"
          draggable
          onDragStart={e => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", key);
            setDraft(layout);
            setDrag(slot);
            setMenuFor(null);
          }}
          onDragEnd={endDrag}
          title="Drag to reorder"
        >
          <GrabHandleIcon />
        </span>
        {disclosure ? (
          <button
            type="button"
            className="dataset-column-picker-disclosure"
            aria-label={`${disclosure.open ? "Hide" : "Show"} ${title}'s keys`}
            aria-expanded={disclosure.open}
            onClick={disclosure.toggle}
          >
            {disclosure.open ? "▾" : "▸"}
          </button>
        ) : (
          slot.key === undefined && (
            <span className="dataset-column-picker-disclosure" />
          )
        )}
        <label className="trace-column-picker-check">
          <input
            type="checkbox"
            aria-label={`Show ${title}`}
            checked={!hidden}
            onChange={() => onChange(setHidden(layout, slot, !hidden))}
          />
          <span className="dataset-column-picker-title">{title}</span>
          {detail && (
            <span className="dataset-column-picker-detail">{detail}</span>
          )}
          {isLabel && (
            <span className="dataset-column-picker-badge" title="Row label">
              label
            </span>
          )}
        </label>
        {path && (
          <span className="dataset-column-picker-more">
            <button
              type="button"
              className="dataset-column-picker-icon-btn"
              aria-label={`More for ${title}`}
              aria-expanded={menuFor === key}
              onClick={() => setMenuFor(m => (m === key ? null : key))}
            >
              ⋯
            </button>
            {menuFor === key && (
              <div className="trace-header-menu dataset-column-picker-menu">
                <button
                  type="button"
                  className="trace-header-menu-item"
                  onClick={() => {
                    setMenuFor(null);
                    onRowLabel(isLabel ? undefined : path);
                  }}
                >
                  <span className="trace-header-menu-item-label">
                    {isLabel ? "Don't use as row label" : "Use as row label"}
                  </span>
                </button>
              </div>
            )}
          </span>
        )}
        {removable && (
          <button
            type="button"
            className="dataset-column-picker-icon-btn"
            aria-label={`Remove column ${title}`}
            title="Remove column"
            onClick={() => onRemove(slot.index)}
          >
            ✕
          </button>
        )}
      </div>
    );
  };

  const topRow = (column: LayoutColumn, index: number) => {
    const slot = { index };
    switch (column.kind) {
      case "field": {
        const isOpen = disclosed.has(column.fieldId);
        const row = pickerRow({
          slot,
          title: fieldName(column.fieldId),
          hidden: column.hidden,
          ...(column.keys.length > 0 && {
            disclosure: {
              open: isOpen,
              toggle: () => {
                const next = new Set(disclosed);
                if (!next.delete(column.fieldId)) next.add(column.fieldId);
                setDisclosed(next);
              },
            },
          }),
        });
        if (!isOpen) return row;
        return [
          row,
          ...column.keys.map(k =>
            pickerRow({
              slot: { index, key: k.key },
              title: k.key,
              hidden: k.hidden,
            }),
          ),
        ];
      }
      case "added":
        return pickerRow({
          slot,
          title: column.title ?? addedTitle(column.path, fields),
          detail: pathLabel(column.path, fields),
          hidden: column.hidden,
          removable: true,
        });
      case "source":
        return pickerRow({ slot, title: "source", hidden: column.hidden });
      case "unknown":
        return pickerRow({
          slot,
          title: "Unknown column",
          detail: column.spec.kind,
          hidden: column.hidden,
          dim: true,
        });
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`trace-view-prompt-btn${open ? " dataset-columns-btn-active" : ""}`}
        title="Show, hide, reorder and add columns"
        aria-label="Columns"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ColumnsIcon />
        Columns
        <ChevronDownIcon />
      </button>
      {open &&
        createPortal(
          <div
            className="trace-column-picker dataset-column-picker"
            ref={popoverRef}
            style={style}
            role="dialog"
            aria-label="Columns"
          >
            {adding ? (
              <AddColumnMenu
                fields={fields}
                instances={instances}
                describePath={describePath}
                onPick={path => {
                  onAdd(path);
                  setAdding(false);
                }}
                newField={newField}
                onFieldAdded={() => {
                  onFieldAdded();
                  setAdding(false);
                }}
                onBack={() => setAdding(false)}
              />
            ) : (
              <>
                {shown.flatMap((column, i) => topRow(column, i))}
                <button
                  type="button"
                  className="trace-header-menu-item dataset-column-picker-add"
                  onClick={() => {
                    setMenuFor(null);
                    setAdding(true);
                  }}
                >
                  <span className="trace-header-menu-item-label">
                    Add column…
                  </span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
