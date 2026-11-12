// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { type ReactNode, useEffect, useState } from "react";
import {
  nextSort,
  parseTableModeMemory,
  type SortState,
  type SortValue,
  sortItems,
  type TableModeMemory,
  toggleTableMode,
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
  /** Shown under the header, whatever the list holds: a search box, say. */
  toolbar?: ReactNode;
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
  /**
   * How many items are grouped under `item`, for a group whose items are
   * fetched only once it's expanded: `item` is then a group even while
   * {@link itemChildren} has nothing for it. `undefined` for any other item.
   */
  itemGroupCount?: (item: T) => number | undefined;
  /**
   * Called for a group that's expanded while {@link itemChildren} has
   * nothing for it, to fetch its items — again on each render until it has,
   * so it should ignore a group it's already fetching.
   */
  onExpandGroup?: (item: T) => void;
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
  /** Set for a group: how many items it holds. */
  count?: number;
  /** A group's items, once they're known. */
  children?: T[];
  /** Stands in for an expanded group's items until they're known. */
  placeholder?: boolean;
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
  if (row.count !== undefined) name += ` ${base}-group`;
  if (row.placeholder) name += ` ${base}-loading`;
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
  if (row.placeholder) {
    return <span className="trace-list-name">Loading…</span>;
  }
  const group = row.count !== undefined;
  return (
    <>
      {group && (
        <span className="trace-list-chevron">
          <ChevronIcon open={!!row.open} />
        </span>
      )}
      {itemMarker?.(row.item)}
      <span className="trace-list-name">{itemName(row.item)}</span>
      {group && <span className="trace-list-group-count">{row.count}</span>}
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

/** The table-mode memory kept in `localStorage` under `key`. */
function loadTableModeMemory(key: string): TableModeMemory {
  try {
    return parseTableModeMemory(
      JSON.parse(localStorage.getItem(key) ?? "null"),
    );
  } catch {
    return parseTableModeMemory(null);
  }
}

/**
 * Header button that toggles the sidebar between two modes, each with its own
 * width: the one it has now, and `tableWidth` (enough for the table layout)
 * until the other has been visited. Each mode remembers the width it was last
 * left at, across reloads too.
 */
export function TableModeButton({
  sidebarWidth,
  onResizeSidebar,
  tableWidth,
  storageKey,
}: {
  /** The sidebar's current width, in px. */
  sidebarWidth: number;
  onResizeSidebar: (width: number) => void;
  tableWidth: number;
  /** Tells this list's remembered widths from the other lists'. */
  storageKey: string;
}) {
  const key = `table-mode:${storageKey}`;
  const [memory, setMemory] = useState(() => loadTableModeMemory(key));

  const toggle = () => {
    const next = toggleTableMode(memory, sidebarWidth, tableWidth);
    setMemory(next.memory);
    try {
      localStorage.setItem(key, JSON.stringify(next.memory));
    } catch {
      /* ignore */
    }
    onResizeSidebar(next.width);
  };

  return (
    <button
      type="button"
      className="tree-toolbar-btn"
      title="Toggle table view"
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
  toolbar,
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
  itemGroupCount,
  onExpandGroup,
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

  // Fetch the items of every expanded group that doesn't have them yet:
  // one just expanded, or one left open across a change of what's listed.
  useEffect(() => {
    if (!onExpandGroup) return;
    for (const item of items) {
      if (
        expanded.has(itemKey(item)) &&
        itemGroupCount?.(item) !== undefined &&
        !itemChildren?.(item)
      ) {
        onExpandGroup(item);
      }
    }
  });

  const header = (
    <>
      <div className="section-panel-header">
        <span>{title}</span>
        {headerActions && (
          <div className="section-panel-header-actions">{headerActions}</div>
        )}
      </div>
      {toolbar}
    </>
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
    const count = itemGroupCount?.(item) ?? children?.length;
    if (count === undefined) return [{ item, key }];
    const open = expanded.has(key);
    const group = { item, key, count, children, open };
    if (!open) return [group];
    if (!children) {
      return [
        group,
        { item, key: `${key}:loading`, child: true, placeholder: true },
      ];
    }
    return [
      group,
      ...sortList(children).map(child => ({
        item: child,
        key: itemKey(child),
        child: true,
      })),
    ];
  });
  // A group's row toggles it; any other row selects its item.
  const onRowClick = (row: ListRow<T>) => {
    if (row.placeholder) return;
    if (row.count !== undefined) toggleExpanded(row.key);
    else onSelect(row.item);
  };
  const rowTitle = (row: ListRow<T>) =>
    row.placeholder ? undefined : itemTitle(row.item);
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
                title={rowTitle(row)}
                {...(row.count !== undefined && {
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
                  {(row.placeholder ? [] : cardColumns).map(column => {
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
                  title={rowTitle(row)}
                  aria-expanded={row.count !== undefined ? row.open : undefined}
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
                      {!row.placeholder && column.cell(item)}
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
