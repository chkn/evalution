// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { isTraceTextColumn, type TraceTextColumn } from "@evalution/sdk";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  TraceDateResolution,
  TraceFilter,
  TraceGroup,
  TraceNumberColumn,
  TraceQueryColumn,
  VariationInfo,
} from "../../shared/types";
import type { TraceListing } from "../hooks/useTraces";
import { FilterIcon, GroupIcon } from "./trace/icons.tsx";
import { traceColumnIcon } from "./trace-column-icon";
import {
  fromDateTimeInput,
  rangeFilter,
  setColumnFilter,
  TRACE_COLUMN_LABELS,
  TRACE_FILTER_UNITS,
  TRACE_QUERY_COLUMNS,
  TRACE_RESOLUTION_LABELS,
  type TraceListGrouping,
  toDateTimeInput,
  traceFilterLabel,
  traceFilterValueLabel,
  traceValueLabel,
  typedRange,
  typedRangeFilter,
} from "./trace-list-view";
import { useAnchoredPopover } from "./use-anchored-popover";

/** How long after the last keystroke a search is run. */
const SEARCH_DELAY_MS = 200;

/** The most values a column's filter offers to choose from. */
const MAX_FACETS = 100;

type Variations = Record<string, VariationInfo>;

/**
 * The trace list's search box: runs `onChange` once typing pauses, so a
 * search that the server answers isn't asked once per letter.
 */
export function TraceSearchBox({
  value,
  onChange,
  onEscape,
}: {
  value: string;
  onChange: (search: string) => void;
  /** Called when Esc is pressed in the box: the caller clears and hides it. */
  onEscape: () => void;
}) {
  const [text, setText] = useState(value);
  // What the list was last told, to tell typing from a search set elsewhere.
  const told = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (value === told.current) return;
    told.current = value;
    setText(value);
  }, [value]);

  useEffect(() => {
    if (text === told.current) return;
    const timer = setTimeout(() => {
      told.current = text;
      onChangeRef.current(text);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div className="tree-header-search trace-list-search">
      <input
        type="search"
        placeholder="Search traces"
        aria-label="Search traces"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") {
            e.preventDefault();
            onEscape();
          }
        }}
        autoFocus
      />
    </div>
  );
}

/** The filters applied, each with a button that removes it. */
export function TraceFilterChips({
  filters,
  variations,
  onRemove,
}: {
  filters: TraceFilter[];
  variations: Variations;
  onRemove: (filter: TraceFilter) => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="trace-filter-chips">
      {filters.map(filter => {
        const label = traceFilterLabel(filter, variations);
        return (
          <span key={filter.column} className="trace-filter-chip" title={label}>
            <span className="trace-filter-chip-label">{label}</span>
            <button
              type="button"
              className="trace-filter-chip-remove"
              aria-label={`Remove filter ${label}`}
              onClick={() => onRemove(filter)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * A menu row's label, led by `icon` when there is one. The rows without one
 * (Name, Status, Runs, None) keep their text aligned with the others'.
 */
function MenuRowLabel({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="trace-menu-row-label">
      <span className="trace-menu-row-icon" aria-hidden>
        {icon}
      </span>
      {children}
    </span>
  );
}

/** An input that hands over what's typed on Enter or on losing focus. */
function CommitInput({
  type,
  value,
  label,
  onCommit,
}: {
  type: "number" | "datetime-local";
  value: string;
  label: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <label className="trace-filter-field">
      <span>{label}</span>
      <input
        type={type}
        value={text}
        {...(type === "number" && { min: 0, step: "any" })}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
}

const typedNumber = (text: string): number | undefined => {
  const value = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** A number column's filter: the least and the most it allows. */
function RangeEditor({
  column,
  filter,
  onChange,
}: {
  column: Exclude<TraceNumberColumn, "startTime">;
  filter: TraceFilter | undefined;
  onChange: (filter: TraceFilter | undefined) => void;
}) {
  const { min, max } = typedRange(column, filter);
  const { unit } = TRACE_FILTER_UNITS[column];
  return (
    <div className="trace-filter-fields">
      <CommitInput
        type="number"
        label={`At least (${unit})`}
        value={min === undefined ? "" : String(min)}
        onCommit={text =>
          onChange(typedRangeFilter(column, typedNumber(text), max))
        }
      />
      <CommitInput
        type="number"
        label={`At most (${unit})`}
        value={max === undefined ? "" : String(max)}
        onCommit={text =>
          onChange(typedRangeFilter(column, min, typedNumber(text)))
        }
      />
    </div>
  );
}

/** The date filter: when a trace started, from and until. */
function DateEditor({
  filter,
  onChange,
}: {
  filter: TraceFilter | undefined;
  onChange: (filter: TraceFilter | undefined) => void;
}) {
  const { min, max } =
    filter?.op === "range" ? filter : { min: undefined, max: undefined };
  return (
    <div className="trace-filter-fields">
      <CommitInput
        type="datetime-local"
        label="From"
        value={toDateTimeInput(min)}
        onCommit={text =>
          onChange(rangeFilter("startTime", fromDateTimeInput(text), max))
        }
      />
      <CommitInput
        type="datetime-local"
        label="Until"
        value={toDateTimeInput(max)}
        onCommit={text =>
          onChange(rangeFilter("startTime", min, fromDateTimeInput(text)))
        }
      />
    </div>
  );
}

/**
 * A text column's filter: the values it takes among the traces the rest of
 * the view matches, each with how many traces have it, to tick.
 */
function ValueEditor({
  column,
  filter,
  listing,
  variations,
  onChange,
}: {
  column: TraceTextColumn;
  filter: TraceFilter | undefined;
  listing: TraceListing;
  variations: Variations;
  onChange: (filter: TraceFilter | undefined) => void;
}) {
  const [facets, setFacets] = useState<TraceGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { facets: loadFacets } = listing;
  useEffect(() => {
    let current = true;
    loadFacets(column)
      .then(found => current && setFacets(found))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [column, loadFacets]);

  const chosen = filter?.op === "in" ? filter.values : [];
  const counts = new Map<string | null, number>();
  for (const facet of facets ?? []) {
    if (facet.filter.op !== "in") continue;
    counts.set(facet.filter.values[0] ?? null, facet.count);
  }
  // What's ticked stays listed even when nothing matches it any more.
  for (const value of chosen) if (!counts.has(value)) counts.set(value, 0);
  const values = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_FACETS);

  const toggle = (value: string | null) => {
    const next = chosen.includes(value)
      ? chosen.filter(v => v !== value)
      : [...chosen, value];
    onChange(next.length > 0 ? { column, op: "in", values: next } : undefined);
  };

  if (values.length === 0) {
    return (
      <div className="trace-filter-status">
        {failed ? "Couldn't load values." : facets ? "No values." : "Loading…"}
      </div>
    );
  }
  return (
    <div className="trace-filter-values">
      {values.map(([value, count]) => (
        <label key={value ?? "\0"} className="trace-filter-value">
          <input
            type="checkbox"
            checked={chosen.includes(value)}
            onChange={() => toggle(value)}
          />
          <span className="trace-filter-value-label">
            {traceValueLabel(column, value, variations)}
          </span>
          <span className="trace-filter-value-count">{count}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Trigger + popover for filtering the trace list: pick a column, then what
 * of it to allow. Text columns offer their values to tick, number columns
 * a least and a most, and the date a from and an until.
 */
export function TraceFilterButton({
  listing,
  variations,
}: {
  listing: TraceListing;
  variations: Variations;
}) {
  const [open, setOpen] = useState(false);
  const [column, setColumn] = useState<TraceQueryColumn | null>(null);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: () => setOpen(false),
      matchTriggerWidth: false,
    });
  const { view, setView } = listing;
  const filterOf = (key: TraceQueryColumn) =>
    view.filters.find(filter => filter.column === key);
  const setFilter = (key: TraceQueryColumn, filter: TraceFilter | undefined) =>
    setView({ ...view, filters: setColumnFilter(view.filters, key, filter) });
  const active = view.filters.length > 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`tree-toolbar-btn${open || active ? " tree-toolbar-btn-active" : ""}`}
        title="Filter"
        aria-pressed={active}
        onClick={() => {
          setColumn(null);
          setOpen(v => !v);
        }}
      >
        <FilterIcon />
      </button>
      {open &&
        createPortal(
          <div
            className="trace-column-picker trace-filter-popover"
            ref={popoverRef}
            style={style}
          >
            {column === null ? (
              <>
                {TRACE_QUERY_COLUMNS.map(key => {
                  const filter = filterOf(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      className="trace-menu-row"
                      onClick={() => setColumn(key)}
                    >
                      <MenuRowLabel icon={traceColumnIcon(key)}>
                        {TRACE_COLUMN_LABELS[key]}
                      </MenuRowLabel>
                      {filter && (
                        <span className="trace-menu-row-detail">
                          {traceFilterValueLabel(filter, variations)}
                        </span>
                      )}
                    </button>
                  );
                })}
                {active && (
                  <button
                    type="button"
                    className="trace-menu-row trace-menu-row-footer"
                    onClick={() => setView({ ...view, filters: [] })}
                  >
                    Clear all filters
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="trace-filter-header">
                  <button
                    type="button"
                    className="trace-filter-back"
                    aria-label="Back to columns"
                    onClick={() => setColumn(null)}
                  >
                    ‹
                  </button>
                  <span>{TRACE_COLUMN_LABELS[column]}</span>
                  {filterOf(column) && (
                    <button
                      type="button"
                      className="trace-filter-clear"
                      onClick={() => setFilter(column, undefined)}
                    >
                      Clear
                    </button>
                  )}
                </div>
                {column === "startTime" ? (
                  <DateEditor
                    filter={filterOf(column)}
                    onChange={filter => setFilter(column, filter)}
                  />
                ) : isTraceTextColumn(column) ? (
                  <ValueEditor
                    column={column}
                    filter={filterOf(column)}
                    listing={listing}
                    variations={variations}
                    onChange={filter => setFilter(column, filter)}
                  />
                ) : (
                  <RangeEditor
                    column={column}
                    filter={filterOf(column)}
                    onChange={filter => setFilter(column, filter)}
                  />
                )}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

const sameGrouping = (a: TraceListGrouping, b: TraceListGrouping) =>
  typeof a === "string" || typeof b === "string"
    ? a === b
    : a.column === b.column;

/**
 * Trigger + popover for how the trace list gathers its traces: under their
 * runs (the default), not at all, or by any column. Grouping by date also
 * asks at what resolution.
 */
export function TraceGroupButton({
  grouping,
  onChange,
}: {
  grouping: TraceListGrouping;
  onChange: (grouping: TraceListGrouping) => void;
}) {
  const [open, setOpen] = useState(false);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: () => setOpen(false),
      matchTriggerWidth: false,
    });
  const options: {
    label: string;
    icon?: ReactNode;
    grouping: TraceListGrouping;
    /** Set on the first column, to divide the columns from Runs and None. */
    divided?: boolean;
  }[] = [
    { label: "Runs", grouping: "runs" },
    { label: "None", grouping: "none" },
    ...TRACE_QUERY_COLUMNS.map((column, i) => ({
      label: TRACE_COLUMN_LABELS[column],
      icon: traceColumnIcon(column),
      grouping:
        column === "startTime"
          ? { column, resolution: "day" as TraceDateResolution }
          : { column },
      divided: i === 0,
    })),
  ];
  const resolution =
    typeof grouping === "object" && grouping.column === "startTime"
      ? (grouping.resolution ?? "day")
      : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`tree-toolbar-btn${open || grouping !== "runs" ? " tree-toolbar-btn-active" : ""}`}
        title="Group by"
        onClick={() => setOpen(v => !v)}
      >
        <GroupIcon />
      </button>
      {open &&
        createPortal(
          <div
            className="trace-column-picker trace-group-popover"
            ref={popoverRef}
            style={style}
            role="menu"
          >
            {options.map(option => {
              const selected = sameGrouping(option.grouping, grouping);
              const dated = selected && resolution !== undefined;
              const byDate =
                typeof option.grouping === "object" &&
                option.grouping.column === "startTime";
              return (
                <div
                  key={option.label}
                  className={option.divided ? "trace-menu-divided" : undefined}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`trace-menu-row${selected ? " trace-menu-row-selected" : ""}`}
                    onClick={() => {
                      if (!selected) onChange(option.grouping);
                      // Left open on Date, to choose its resolution.
                      if (!byDate) setOpen(false);
                    }}
                  >
                    <MenuRowLabel icon={option.icon}>
                      {option.label}
                    </MenuRowLabel>
                    {selected && <span aria-hidden>✓</span>}
                  </button>
                  {dated && (
                    <div className="trace-group-resolutions">
                      {(
                        Object.keys(
                          TRACE_RESOLUTION_LABELS,
                        ) as TraceDateResolution[]
                      ).map(r => (
                        <button
                          key={r}
                          type="button"
                          aria-pressed={r === resolution}
                          className={`trace-group-resolution${r === resolution ? " trace-group-resolution-selected" : ""}`}
                          onClick={() =>
                            onChange({ column: "startTime", resolution: r })
                          }
                        >
                          {TRACE_RESOLUTION_LABELS[r]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
