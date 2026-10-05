// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { type ReactNode, useState } from "react";
import {
  nextSort,
  type SortState,
  type SortValue,
  sortItems,
} from "./summary-list";
import { ChevronIcon } from "./trace/icons.tsx";

/** One column of a {@link SummaryList} besides the always-shown Name. */
export interface SummaryColumn<T> {
  key: string;
  label: string;
  /** Shown as the table header (the label becomes its tooltip) and before the card's meta value. */
  icon: ReactNode;
  /** Its table width, in px — a fixed-layout column's content otherwise silently overflows into its neighbour. */
  width: number;
  /** This column's value for `item` in the table. */
  cell: (item: T) => ReactNode;
  /** This column's value for `item` in a card's meta row, if it differs from {@link cell} (e.g. "8 spans" rather than a bare 8). `null` leaves it out of the card. */
  card?: (item: T) => ReactNode;
  /** What the table sorts by — omit for a column that can't be sorted. */
  sortValue?: (item: T) => SortValue;
}

interface SummaryListProps<T> {
  /** The section header's title. */
  title: string;
  /** Buttons at the right of the section header. */
  headerActions?: ReactNode;
  loading: boolean;
  error: string | null;
  /** Shown instead of the list when `items` is empty. */
  empty: ReactNode;
  items: T[];
  /** The visible columns, in order. */
  columns: SummaryColumn<T>[];
  /** How many of `columns` the narrow (card) layout's meta row shows. */
  cardColumnCount?: number;
  itemKey: (item: T) => string;
  itemName: (item: T) => string;
  /** The row's tooltip — defaults to its name. */
  itemTitle?: (item: T) => string;
  /** Shown before the name, e.g. a trace's status dot. */
  itemMarker?: (item: T) => ReactNode;
  /**
   * The items grouped under `item`, making it a group: a row that expands
   * (collapsed at first) to show them, indented, rather than being selected.
   * `undefined` for an ordinary item.
   */
  itemChildren?: (item: T) => T[] | undefined;
  selectedKey: string | null;
  onSelect: (item: T) => void;
  defaultSort: SortState;
}

function SortableHeader({
  label,
  icon,
  sortKey,
  sort,
  onSort,
  className,
  width,
}: {
  label: string;
  icon?: ReactNode;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  className: string;
  width?: number;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={className}
      style={width !== undefined ? { width } : undefined}
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className={`trace-table-sort-btn${active ? " trace-table-sort-btn-active" : ""}`}
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
      >
        {icon ?? label}
        <span className="trace-table-sort-arrow" aria-hidden>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

/** One row of a {@link SummaryList}, in either layout. */
interface ListRow<T> {
  item: T;
  key: string;
  /** Set for a group: its items. */
  children?: T[];
  /** Whether a group is expanded. */
  open?: boolean;
  /** Whether the row is one of a group's items. */
  child?: boolean;
}

/** A row's class names: `base`, plus its modifiers. */
function rowClassName<T>(
  base: string,
  row: ListRow<T>,
  selectedKey: string | null,
): string {
  let name = base;
  if (row.key === selectedKey) name += ` ${base}-selected`;
  if (row.children) name += ` ${base}-group`;
  if (row.child) name += ` ${base}-child`;
  return name;
}

/**
 * A row's name, in either layout: after a group's chevron and the marker, and
 * before a group's count.
 */
function RowLabel<T>({
  row,
  itemName,
  itemMarker,
}: {
  row: ListRow<T>;
  itemName: (item: T) => string;
  itemMarker?: (item: T) => ReactNode;
}) {
  return (
    <>
      {row.children && (
        <span className="trace-list-chevron">
          <ChevronIcon open={!!row.open} />
        </span>
      )}
      {itemMarker?.(row.item)}
      <span className="trace-list-name">{itemName(row.item)}</span>
      {row.children && (
        <span className="trace-list-group-count">{row.children.length}</span>
      )}
    </>
  );
}

/** Two horizontal arrows, stacked and pointing opposite ways — the table-mode toggle. */
function TableModeIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="2" y1="7" x2="18" y2="7" />
      <polyline points="14 3 18 7 14 11" />
      <line x1="22" y1="17" x2="6" y2="17" />
      <polyline points="10 13 6 17 10 21" />
    </svg>
  );
}

/**
 * Header button that widens the sidebar to `tableWidth` (enough for the
 * table layout) and, on a second click, restores the width it had before.
 */
export function TableModeButton({
  sidebarWidth,
  onResizeSidebar,
  tableWidth,
}: {
  /** The sidebar's current width, in px — what a second click restores. */
  sidebarWidth: number;
  onResizeSidebar: (width: number) => void;
  tableWidth: number;
}) {
  // `null` while at its normal width; the width to restore to while expanded
  // for table mode, so the second click can put it back exactly.
  const [savedWidth, setSavedWidth] = useState<number | null>(null);

  const toggle = () => {
    if (savedWidth !== null) {
      onResizeSidebar(savedWidth);
      setSavedWidth(null);
    } else {
      setSavedWidth(sidebarWidth);
      onResizeSidebar(tableWidth);
    }
  };

  return (
    <button
      type="button"
      className={`tree-toolbar-btn${savedWidth !== null ? " tree-toolbar-btn-active" : ""}`}
      title="Toggle table view"
      aria-pressed={savedWidth !== null}
      onClick={toggle}
    >
      <TableModeIcon />
    </button>
  );
}

/**
 * A sidebar section listing summaries (traces, datasets): one card per item
 * while the sidebar is narrow, swapped for a sortable table once it's wide
 * enough for real columns (the `trace-list` container query in `styles.css`).
 */
export function SummaryList<T>({
  title,
  headerActions,
  loading,
  error,
  empty,
  items,
  columns,
  cardColumnCount = 3,
  itemKey,
  itemName,
  itemTitle = itemName,
  itemMarker,
  itemChildren,
  selectedKey,
  onSelect,
  defaultSort,
}: SummaryListProps<T>) {
  const [sort, setSort] = useState<SortState>(defaultSort);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Reveal a newly selected item inside a collapsed group (one opened from
  // elsewhere, say) — once, so the user can still collapse it afterwards.
  const [revealedKey, setRevealedKey] = useState(selectedKey);
  if (selectedKey !== revealedKey) {
    setRevealedKey(selectedKey);
    const group = items.find(item =>
      itemChildren?.(item)?.some(child => itemKey(child) === selectedKey),
    );
    const groupKey = group && itemKey(group);
    if (groupKey !== undefined && !expanded.has(groupKey)) {
      setExpanded(prev => new Set(prev).add(groupKey));
    }
  }

  const header = (
    <div className="section-panel-header">
      <span>{title}</span>
      {headerActions && (
        <div className="section-panel-header-actions">{headerActions}</div>
      )}
    </div>
  );

  if (loading || error || items.length === 0) {
    return (
      <>
        {header}
        <div className="section-panel-body">
          {loading ? (
            <div className="tree-status">Loading...</div>
          ) : error ? (
            <div className="tree-status tree-error">Error: {error}</div>
          ) : (
            <div className="tree-empty-state">{empty}</div>
          )}
        </div>
      </>
    );
  }

  const sortColumn = columns.find(c => c.key === sort.key);
  const sortList = (list: T[]) =>
    sort.key === "name"
      ? sortItems(list, itemName, sort.dir)
      : sortColumn?.sortValue
        ? sortItems(list, sortColumn.sortValue, sort.dir)
        : list;
  // Groups sort among the other items, and their own items among themselves.
  const rows: ListRow<T>[] = sortList(items).flatMap(item => {
    const key = itemKey(item);
    const children = itemChildren?.(item);
    if (!children) return [{ item, key }];
    const open = expanded.has(key);
    return [
      { item, key, children, open },
      ...(open
        ? sortList(children).map(child => ({
            item: child,
            key: itemKey(child),
            child: true,
          }))
        : []),
    ];
  });
  // A group's row toggles it; any other row selects its item.
  const onRowClick = (row: ListRow<T>) =>
    row.children ? toggleExpanded(row.key) : onSelect(row.item);
  const cardColumns = columns.slice(0, cardColumnCount);
  const onSort = (key: string) => setSort(prev => nextSort(prev, key));

  return (
    <>
      {header}
      <div className="section-panel-body trace-list">
        {/* Card layout — the default, and the only one left once the sidebar
            gets too narrow for the table's columns (its meta row disappears
            below that). */}
        <div className="trace-list-cards">
          {rows.map(row => {
            const { item } = row;
            return (
              <div
                key={row.key}
                className={rowClassName("trace-list-row", row, selectedKey)}
                onClick={() => onRowClick(row)}
                title={itemTitle(item)}
                {...(row.children && {
                  role: "button",
                  "aria-expanded": row.open,
                })}
              >
                <div className="trace-list-row-top">
                  <RowLabel
                    row={row}
                    itemName={itemName}
                    itemMarker={itemMarker}
                  />
                </div>
                <div className="trace-list-row-meta">
                  {cardColumns.map(column => {
                    const content = (column.card ?? column.cell)(item);
                    if (content === null) return null;
                    return (
                      <span key={column.key} className="trace-list-meta-item">
                        {column.icon}
                        {content}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Table layout — shown instead of the cards once the sidebar is
            wide enough for sortable columns. */}
        <table className="trace-table">
          <thead>
            <tr>
              <SortableHeader
                label="Name"
                sortKey="name"
                sort={sort}
                onSort={onSort}
                className="trace-table-name-th"
              />
              {columns.map(column => {
                // Targeted by column key rather than position, since the
                // trace list's column picker lets the user reorder them.
                const className = `trace-table-th trace-table-col-${column.key}`;
                if (!column.sortValue) {
                  return (
                    <th
                      key={column.key}
                      className={className}
                      style={{ width: column.width }}
                      title={column.label}
                    >
                      {column.icon}
                    </th>
                  );
                }
                return (
                  <SortableHeader
                    key={column.key}
                    label={column.label}
                    icon={column.icon}
                    sortKey={column.key}
                    sort={sort}
                    onSort={onSort}
                    className={className}
                    width={column.width}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const { item } = row;
              return (
                <tr
                  key={row.key}
                  className={rowClassName("trace-table-row", row, selectedKey)}
                  onClick={() => onRowClick(row)}
                  title={itemTitle(item)}
                  aria-expanded={row.children ? row.open : undefined}
                >
                  <td>
                    <div className="trace-table-name-cell">
                      <RowLabel
                        row={row}
                        itemName={itemName}
                        itemMarker={itemMarker}
                      />
                    </div>
                  </td>
                  {columns.map(column => (
                    <td
                      key={column.key}
                      className={`trace-table-col-${column.key}`}
                    >
                      {column.cell(item)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
