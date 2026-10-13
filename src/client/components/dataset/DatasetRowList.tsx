// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useRef, useState } from "react";
import type { DatasetRow } from "../../../shared/types.ts";

/** Each entry's height; the list is virtualized on it. */
export const ROW_LIST_ITEM_HEIGHT = 30;

interface Props {
  rowCount: number;
  /** The row at `index`, if its page is loaded. */
  getRow: (index: number) => DatasetRow | undefined;
  /** Loads the rows in `[start, end)`. */
  ensure: (start: number, end: number) => void;
  /** A row's label, when the dataset names its rows. */
  label: (row: DatasetRow) => string | undefined;
  selected: number | null;
  onSelect: (index: number) => void;
}

/**
 * The narrow list of rows beside a dataset view tab, which takes the grid's
 * place: each row by number and label, paged in as it scrolls, with ↑/↓ to
 * move the selection. See `specs/dataset-views.md` §C.
 */
export function DatasetRowList({
  rowCount,
  getRow,
  ensure,
  label,
  selected,
  onSelect,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const start = Math.floor(el.scrollTop / ROW_LIST_ITEM_HEIGHT);
    const end = start + Math.ceil(el.clientHeight / ROW_LIST_ITEM_HEIGHT) + 1;
    setRange(r => (r.start === start && r.end === end ? r : { start, end }));
  };
  useEffect(measure, []);
  useEffect(() => {
    ensure(range.start, Math.min(range.end, rowCount));
  }, [ensure, range, rowCount]);

  // Keep the selected row in view.
  useEffect(() => {
    const el = ref.current;
    if (!el || selected === null) return;
    const top = selected * ROW_LIST_ITEM_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_LIST_ITEM_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_LIST_ITEM_HEIGHT - el.clientHeight;
    }
  }, [selected]);

  const items = [];
  for (let i = range.start; i < Math.min(range.end, rowCount); i++) {
    const row = getRow(i);
    const text = row ? label(row) : undefined;
    items.push(
      <div
        key={i}
        role="option"
        tabIndex={-1}
        aria-selected={i === selected}
        className={`dataset-row-list-item${i === selected ? " dataset-row-list-item-selected" : ""}`}
        style={{ top: i * ROW_LIST_ITEM_HEIGHT }}
        onClick={() => onSelect(i)}
      >
        <span className="dataset-row-list-number">{i + 1}</span>
        <span className="dataset-row-list-label">
          {row ? (text ?? `Row ${i + 1}`) : "…"}
        </span>
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      className="dataset-row-list"
      role="listbox"
      aria-label="Rows"
      tabIndex={0}
      onScroll={measure}
      onKeyDown={e => {
        if (rowCount === 0) return;
        const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = Math.min(
          rowCount - 1,
          Math.max(0, (selected ?? -step) + step),
        );
        if (next !== selected) onSelect(next);
      }}
    >
      <div
        className="dataset-row-list-inner"
        style={{ height: rowCount * ROW_LIST_ITEM_HEIGHT }}
      >
        {items}
      </div>
    </div>
  );
}
