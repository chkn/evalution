// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import "@glideapps/glide-data-grid/dist/index.css";
import {
  booleanCellRenderer,
  bubbleCellRenderer,
  CompactSelection,
  DataEditorCore,
  type DrawHeaderCallback,
  type EditableGridCell,
  type EditListItem,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
  type ImageWindowLoader,
  type InnerGridCell,
  type InternalCellRenderer,
  type Item,
  loadingCellRenderer,
  markerCellRenderer,
  newRowCellRenderer,
  numberCellRenderer,
  type Rectangle,
  type Theme,
  textCellRenderer,
} from "@glideapps/glide-data-grid";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { shortSyntax } from "ts-proppy/react";
import type {
  Dataset,
  DatasetRow,
  DatasetRowsOverview,
  ExecutionInput,
  NormalizedPrompt,
  PromptID,
} from "../../shared/types";
import {
  addDatasetRows,
  deleteDataset,
  deleteDatasetRow,
  getDataset,
  getDatasetRows,
  renameDataset,
  updateDatasetRows,
} from "../api";
import { DatasetAddField } from "./DatasetAddField";
import { DatasetRowDetails } from "./DatasetRowDetails";
import { DetailsPane, DetailsPaneHeader, useIsWide } from "./DetailsPane";
import {
  buildColumns,
  type CellEdit,
  type CellView,
  cellEdits,
  cellView,
  clearEdits,
  type DatasetColumn,
  type DatasetLayout,
  DEFAULT_LAYOUT,
  type EditorValue,
  editableCell,
  fieldIdsByGroup,
  fitsEditor,
  type GridEdit,
  groupEdits,
  groupHeader,
  layoutStorageKey,
  parseDatasetLayout,
  RowPager,
  serializeDatasetLayout,
} from "./dataset-grid";
import { GRID_HEADER_ICONS } from "./grid-sprites";
import {
  fromRow,
  type PanelFill,
  panelFill,
  staleFields,
} from "./named-inputs";
import { formatTimestamp, formatTimestampCompact } from "./trace/format.ts";
import {
  CalendarIcon,
  DatasetsIcon,
  MoreIcon,
  PromptLinkIcon,
  TrashIcon,
} from "./trace/icons.tsx";
import { useAnchoredPopover } from "./use-anchored-popover";
import { useContentRectTest } from "./use-content-rect-test";
import { GRID_MONO_FONT, useGridTheme } from "./use-grid-theme";

interface Props {
  providerId: string;
  datasetId: string;
  /**
   * Bumped whenever this dataset changes on the server (a `dataset-changed`
   * event), so the view refetches.
   */
  version: number;
  /** Looks up the prompt a (resolved) prompt reference names, if loaded. */
  findPrompt: (prompt: PromptID) => NormalizedPrompt | undefined;
  /**
   * Every loaded prompt, whose parameters a new field can copy the type of.
   * Defaults to none: only the primitive types are offered.
   */
  prompts?: readonly NormalizedPrompt[];
  /** Opens `prompt` in a split pane, as it is. */
  onOpenPrompt: (prompt: NormalizedPrompt) => void;
  /** Opens `prompt` in a split pane with its execute panel filled. */
  onOpenInPlayground: (prompt: NormalizedPrompt, fill: PanelFill) => void;
  /** Opens a row's source trace. */
  onOpenTrace: (providerId: string, traceId: string) => void;
  /** Called after the dataset itself has been deleted. */
  onDeleted: () => void;
}

/**
 * The only cell kinds the table draws — so the rest (markdown, images) aren't
 * bundled. Glide types its own full list the same way: each renderer is
 * narrower than the union it's looked up by. Number and boolean are here for
 * their editors (§P.2); a renderer brings its cell's editor with it.
 */
const RENDERERS = [
  markerCellRenderer,
  textCellRenderer,
  numberCellRenderer,
  booleanCellRenderer,
  bubbleCellRenderer,
  loadingCellRenderer,
  // The trailing "New row": its ＋ and hint draw nothing without it.
  newRowCellRenderer,
] as readonly InternalCellRenderer<InnerGridCell>[];

/**
 * What an edited Glide cell holds, as `{ value }` — or `undefined` for a
 * kind the table never edits, which is then skipped.
 */
function editorValue(
  cell: EditableGridCell,
): { value: EditorValue } | undefined {
  switch (cell.kind) {
    case GridCellKind.Text:
    case GridCellKind.Number:
    case GridCellKind.Boolean:
      return { value: cell.data };
    default:
      return undefined;
  }
}

/** The table draws no images, so the loader Glide requires loads none. */
const NO_IMAGES: ImageWindowLoader = {
  setWindow: () => {},
  loadOrGetImage: () => undefined,
  setCallback: () => {},
};

/**
 * This viewer's layout for one dataset — which fields they expanded, which
 * columns they resized. A convenience, so a browser that refuses storage
 * just opens the default layout.
 */
function loadLayout(key: string): DatasetLayout {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return parseDatasetLayout(JSON.parse(stored));
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYOUT;
}

function saveLayout(key: string, layout: DatasetLayout): void {
  try {
    localStorage.setItem(key, serializeDatasetLayout(layout));
  } catch {
    /* ignore */
  }
}

/** Drops a deleted dataset's layout, rather than leaving a key behind. */
function forgetLayout(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * The grid's row and header heights. Kept here rather than left to Glide's
 * defaults because the cover below the last row is placed from them.
 */
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 32;
const GROUP_HEADER_HEIGHT = 26;

const NO_PROMPTS: readonly NormalizedPrompt[] = [];

const NO_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

/**
 * A cell typed into in place, as the Glide cell whose editor fits its type.
 * An empty one draws a dim dash but opens its editor empty.
 */
function editorCell(
  view: Extract<CellView, { kind: "edit" }>,
  theme: Partial<Theme>,
): GridCell {
  const dim = view.value === undefined && {
    themeOverride: { textDark: theme.textLight },
  };
  switch (view.base) {
    case "boolean":
      return {
        kind: GridCellKind.Boolean,
        data: typeof view.value === "boolean" ? view.value : null,
        allowOverlay: false,
        readonly: false,
      };
    case "number":
      return {
        kind: GridCellKind.Number,
        data: typeof view.value === "number" ? view.value : undefined,
        displayData: view.text,
        allowOverlay: true,
        readonly: false,
        ...dim,
      };
    case "string":
      return {
        kind: GridCellKind.Text,
        data: typeof view.value === "string" ? view.value : "",
        displayData: view.text,
        allowOverlay: true,
        readonly: false,
        ...dim,
      };
  }
}

/** A {@link CellView} as a Glide cell. */
function toGridCell(view: CellView, theme: Partial<Theme>): GridCell {
  const text = (
    displayData: string,
    extra: Partial<Omit<GridCell, "kind">> = {},
  ): GridCell => ({
    kind: GridCellKind.Text,
    data: displayData,
    displayData,
    allowOverlay: false,
    readonly: true,
    ...extra,
  });
  switch (view.kind) {
    case "loading":
      return { kind: GridCellKind.Loading, allowOverlay: false };
    case "edit":
      return editorCell(view, theme);
    case "empty":
      return text("—", { themeOverride: { textDark: theme.textLight } });
    case "n/a":
      return text("n/a", {
        themeOverride: {
          textDark: theme.textLight,
          bgCell: theme.bgCellMedium,
        },
      });
    case "chip":
      return {
        kind: GridCellKind.Bubble,
        data: [view.text],
        allowOverlay: false,
      };
    case "text":
      return text(view.text, {
        ...(view.tone === "dim" && {
          themeOverride: { textDark: theme.textMedium },
        }),
        ...(view.tone === "link" && {
          themeOverride: { textDark: theme.linkColor },
          cursor: "pointer",
        }),
      });
  }
}

/**
 * A dataset's rows as a virtualized grid, paged in from the server as they
 * scroll into view. A field whose cells hold resources or objects can be
 * expanded, from its group header, into a column per argument or property.
 * Selecting a row shows it in full in the details pane, which is also where
 * it's opened in the playground or deleted. See `specs/datasets.md` §J.
 *
 * Cells of `string`, `number`, and `boolean` fields are typed into in place,
 * pasted over, and cleared with Delete; every other value cell is edited in
 * the details pane. An edit shows at once; if its save fails, the rows are
 * reloaded from the server.
 * See `specs/datasets.md` §P.2.
 */
function DatasetView({
  providerId,
  datasetId,
  version,
  findPrompt,
  prompts = NO_PROMPTS,
  onOpenPrompt,
  onOpenInPlayground,
  onOpenTrace,
  onDeleted,
}: Props) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [overview, setOverview] = useState<DatasetRowsOverview>({
    rowCount: 0,
    fields: {},
  });
  const [error, setError] = useState<string | null>(null);
  /** Bumped after a local change, to refetch as a `version` bump would. */
  const [reload, setReload] = useState(0);
  /** Bumped whenever a page of rows lands, so the grid and pane redraw. */
  const [loaded, setLoaded] = useState(0);
  /**
   * Rows appended from the trailing row that the server hasn't answered for
   * yet. A refetch adds them to the server's count, so one landing while
   * another append is in flight doesn't take that row away. Replaced, not
   * zeroed, when the dataset changes, so an append still in flight for the
   * last one settles against its own count.
   */
  const pendingAppends = useRef({ count: 0 });
  /**
   * Why the last append failed, kept for the refetch that follows it — which
   * would otherwise clear the error before it's seen.
   */
  const appendError = useRef<string | null>(null);
  const layoutKey = layoutStorageKey(providerId, datasetId);
  const [layout, setLayout] = useState<DatasetLayout>(() =>
    loadLayout(layoutKey),
  );
  const { expanded, widths } = layout;
  // Written where it changes rather than in an effect: an effect would fire
  // on the load below too, saving one dataset's layout under another's key.
  const updateLayout = useCallback(
    (next: DatasetLayout) => {
      setLayout(next);
      saveLayout(layoutKey, next);
    },
    [layoutKey],
  );
  const layoutKeyRef = useRef(layoutKey);
  useEffect(() => {
    if (layoutKeyRef.current === layoutKey) return;
    layoutKeyRef.current = layoutKey;
    setLayout(loadLayout(layoutKey));
  }, [layoutKey]);
  const [selection, setSelection] = useState<GridSelection>(NO_SELECTION);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const {
    triggerRef: menuTriggerRef,
    popoverRef: menuRef,
    style: menuStyle,
  } = useAnchoredPopover<HTMLButtonElement>({
    open: menuOpen,
    onClose: closeMenu,
    matchTriggerWidth: false,
  });
  const theme = useGridTheme();
  /** Where Glide opens a cell's editor — see the portal below the header. */
  const editorPortalRef = useRef<HTMLDivElement>(null);
  const { ref: bodyRef, isWide: showSidePane } = useIsWide(760);

  const pager = useMemo(
    () =>
      new RowPager(
        (offset, limit) => getDatasetRows(providerId, datasetId, offset, limit),
        () => setLoaded(n => n + 1),
        err => setError(err.message),
      ),
    [providerId, datasetId],
  );
  /** The rows last on screen, so a refetch knows what to reload first. */
  const visibleRef = useRef({ start: 0, end: 0 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `providerId` and `datasetId` are what the count belongs to.
  useEffect(() => {
    pendingAppends.current = { count: 0 };
    appendError.current = null;
  }, [providerId, datasetId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and `reload` are the refetch signals.
  useEffect(() => {
    let cancelled = false;
    getDataset(providerId, datasetId)
      .then(({ dataset, rowCount, fields }) => {
        if (cancelled) return;
        setDataset(dataset);
        setOverview({
          rowCount: rowCount + pendingAppends.current.count,
          fields,
        });
        setError(appendError.current);
        appendError.current = null;
        pager.invalidate();
        const { start, end } = visibleRef.current;
        pager.ensure(start, Math.min(end, rowCount));
      })
      .catch(err => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [providerId, datasetId, version, reload, pager]);

  const linkedPrompt = dataset?.prompt ? findPrompt(dataset.prompt) : undefined;

  const columns = useMemo(
    () =>
      dataset
        ? buildColumns({
            fields: dataset.fields,
            shape: overview.fields,
            expanded,
            shortType: syntax => shortSyntax(syntax, 24),
          })
        : [],
    [dataset, overview.fields, expanded],
  );
  const fieldIdByGroup = useMemo(() => fieldIdsByGroup(columns), [columns]);
  const getGroupDetails = useCallback(
    (group: string) => groupHeader(group, fieldIdByGroup, expanded),
    [fieldIdByGroup, expanded],
  );

  const columnsById = useMemo(
    () => new Map(columns.map(c => [c.id, c])),
    [columns],
  );
  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map(c => ({
        id: c.id,
        title: c.title,
        width: widths[c.id] ?? c.width,
        ...(c.group !== undefined && { group: c.group }),
      })),
    [columns, widths],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` redraws cells as their pages land.
  const getCellContent = useCallback(
    ([col, row]: Item): GridCell =>
      toGridCell(cellView(pager.get(row), columns[col]), theme),
    [columns, pager, theme, loaded],
  );

  const onVisibleRegionChanged = useCallback(
    (range: Rectangle) => {
      const start = range.y;
      const end = range.y + range.height;
      visibleRef.current = { start, end };
      pager.ensure(start, Math.min(end, overview.rowCount));
    },
    [pager, overview.rowCount],
  );

  /** Draws a field's type after its name, dimmed, as the old table did. */
  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      drawContent();
      const column = columnsById.get(args.column.id ?? "");
      if (!column?.type) return;
      const { ctx, rect, theme: t } = args;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.font = `${t.headerFontStyle} ${t.fontFamily}`;
      ctx.textBaseline = "middle";
      const titleMeasure = ctx.measureText(column.title);
      ctx.font = `10.5px ${GRID_MONO_FONT}`;
      ctx.fillStyle = t.textLight;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(
        column.type,
        rect.x + t.cellHorizontalPadding + titleMeasure.width + 6,
        rect.y + rect.height / 2 - titleMeasure.alphabeticBaseline + 0.5,
      );
      ctx.restore();
    },
    [columnsById],
  );

  // The row shown in the details pane is the selected cell's, or the row
  // selected by its marker. A selected cell stays a cell selection — not
  // folded into its row — so it can be typed into, pasted over, and cleared.
  const selectedIndex =
    selection.current?.cell[1] ?? selection.rows.first() ?? null;
  const inRange = selectedIndex !== null && selectedIndex < overview.rowCount;
  const loadedRow = inRange ? pager.get(selectedIndex) : undefined;
  // The pane keeps showing its row even once the pager drops that row's page
  // (scrolled far away) — until another row is selected.
  const shownRef = useRef<{ index: number; row: DatasetRow } | null>(null);
  if (loadedRow && selectedIndex !== null) {
    shownRef.current = { index: selectedIndex, row: loadedRow };
  }
  const selectedRow =
    loadedRow ??
    (inRange && shownRef.current?.index === selectedIndex
      ? shownRef.current.row
      : undefined);

  const openInPlayground = (index: number) => {
    const row = pager.get(index);
    if (!dataset || !linkedPrompt || !row) return;
    onOpenInPlayground(
      linkedPrompt,
      panelFill(fromRow(dataset, row), linkedPrompt, {
        type: "dataset",
        description: `${dataset.name}, row ${index + 1}`,
        providerId,
        datasetId,
        name: dataset.name,
      }),
    );
  };

  /**
   * Whether the grid offers its trailing "New row". A dataset with no fields
   * has nothing a hand-added row could hold.
   */
  const canAppend = !!dataset && dataset.fields.length > 0;

  const grouped = columns.some(c => c.group !== undefined);
  /** Where the table's last row ends, leaving its closing rule in place. */
  const contentBottom =
    (grouped ? GROUP_HEADER_HEIGHT : 0) +
    HEADER_HEIGHT +
    (overview.rowCount + (canAppend ? 1 : 0)) * ROW_HEIGHT +
    1;
  /** Whether the rows run past the bottom of the grid. */
  const { ref: gridRef, matches: overflows } = useContentRectTest(
    useCallback(rect => contentBottom > rect.height, [contentBottom]),
  );

  /**
   * The blank row Glide draws after the last one, which adds a row when
   * clicked (or when ↓ is pressed past the last row). Sticky once the rows
   * overflow the grid, so it stays in reach however far it's scrolled. Not
   * before: Glide pins a sticky trailing row to the canvas's bottom edge,
   * which would leave it under the cover below the last row, apart from the
   * rows.
   */
  const trailingRow = useMemo(
    () => (canAppend ? { hint: "New row", sticky: overflows } : undefined),
    [canAppend, overflows],
  );

  /**
   * The trailing row was clicked: adds an empty row — no cells, and no
   * `source`, which is what "added by hand" looks like (§P.3). Glide focuses
   * the new row only once `rows` has grown, and gives up after about half a
   * second, so the count is bumped at once rather than after the round trip,
   * and counted in {@link pendingAppends} until the server answers. Either
   * way, a refetch then reconciles it — a failed row drops out of the count,
   * and its error is left showing.
   */
  const onRowAppended = useCallback((): Promise<"bottom"> => {
    const pending = pendingAppends.current;
    pending.count++;
    setOverview(o => ({ ...o, rowCount: o.rowCount + 1 }));
    const settled = () => {
      pending.count--;
      if (pending !== pendingAppends.current) return;
      setReload(n => n + 1);
    };
    addDatasetRows(providerId, datasetId, [{ cells: {} }]).then(
      settled,
      (err: Error) => {
        if (pending === pendingAppends.current) {
          appendError.current = err.message;
          setError(err.message);
        }
        settled();
      },
    );
    return Promise.resolve("bottom");
  }, [providerId, datasetId]);

  /**
   * Saves a batch of edits as one `updateRows`, a row per update. The pages
   * they land on are patched first, so an edit shows at once; the
   * `dataset-changed` refetch then replaces them. A failure says why and
   * reloads the visible rows from the server, dropping whatever optimistic
   * edits are on them — any still saving refetch again when they land.
   */
  const saveEdits = useCallback(
    (edits: CellEdit[]) => {
      const updates = groupEdits(edits);
      if (updates.length === 0) return;
      pager.patch(updates);
      setLoaded(n => n + 1);
      updateDatasetRows(providerId, datasetId, updates).catch(err => {
        setError(`Couldn't save: ${err.message}`);
        pager.invalidate();
        const { start, end } = visibleRef.current;
        pager.ensure(start, Math.min(end, overview.rowCount));
      });
    },
    [pager, providerId, datasetId, overview.rowCount],
  );

  /** Sets or clears one cell of one row — the details pane's edits. */
  const saveCell = useCallback(
    (rowId: string, fieldId: string, cell: ExecutionInput | null) =>
      saveEdits([{ rowId, fieldId, cell }]),
    [saveEdits],
  );

  /** A single edit, a paste over a range, or a fill — one batch either way. */
  const onCellsEdited = useCallback(
    (items: readonly EditListItem[]) => {
      const edits: GridEdit[] = [];
      for (const { location, value } of items) {
        const typed = editorValue(value);
        if (typed) edits.push({ col: location[0], row: location[1], ...typed });
      }
      saveEdits(cellEdits(edits, columns, i => pager.get(i)));
      return true;
    },
    [columns, pager, saveEdits],
  );

  /** Refuses, before it's sent, a value that doesn't fit the cell's type. */
  const validateCell = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      const base = editableCell(pager.get(row), columns[col])?.base;
      const typed = editorValue(newValue);
      return base !== undefined && !!typed && fitsEditor(base, typed.value);
    },
    [columns, pager],
  );

  /**
   * Delete/Backspace clears the selected cells to `null`. Handled here
   * rather than left to Glide, which would clear a boolean to `false`, and
   * a selected row to every one of its cells.
   */
  const onDelete = useCallback(
    (selected: GridSelection) => {
      const { current } = selected;
      if (current) {
        saveEdits(
          clearEdits([current.range, ...current.rangeStack], columns, i =>
            pager.get(i),
          ),
        );
      }
      return false;
    },
    [columns, pager, saveEdits],
  );

  const onCellClicked = useCallback(
    ([col, row]: Item) => {
      const column: DatasetColumn | undefined = columns[col];
      const source = pager.get(row)?.source;
      if (column?.role === "source" && source?.kind === "trace") {
        onOpenTrace(source.traceProviderId, source.traceId);
      }
    },
    [columns, pager, onOpenTrace],
  );

  const onGroupHeaderClicked = useCallback(
    (col: number, event: { preventDefault: () => void }) => {
      const column = columns[col];
      if (!column || !("path" in column)) return;
      event.preventDefault();
      const { fieldId } = column.path;
      const next = new Set(expanded);
      if (!next.delete(fieldId)) next.add(fieldId);
      updateLayout({ ...layout, expanded: next });
    },
    [columns, expanded, layout, updateLayout],
  );

  const act = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (error && !dataset) {
    return (
      <div className="dataset-view dataset-view-error">Error: {error}</div>
    );
  }
  if (!dataset) {
    return (
      <div className="dataset-view">
        <div className="trace-view-loading">Loading dataset…</div>
      </div>
    );
  }

  const stale = linkedPrompt ? staleFields(dataset.fields, linkedPrompt) : [];
  const { rowCount } = overview;

  const submitRename = () =>
    act(async () => {
      const trimmed = name.trim();
      setRenaming(false);
      if (!trimmed || trimmed === dataset.name) return;
      setDataset(await renameDataset(providerId, datasetId, trimmed));
    });

  const startRename = () => {
    setName(dataset.name);
    setRenaming(true);
  };

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete “${dataset.name}” and its ${rowCount} row${rowCount === 1 ? "" : "s"}?`,
      )
    )
      return;
    void act(async () => {
      await deleteDataset(providerId, datasetId);
      forgetLayout(layoutKey);
      onDeleted();
    });
  };

  const menu =
    menuOpen &&
    createPortal(
      <div className="trace-header-menu" ref={menuRef} style={menuStyle}>
        <button
          type="button"
          className="trace-header-menu-item dataset-menu-delete"
          onClick={() => {
            setMenuOpen(false);
            handleDelete();
          }}
        >
          <span className="trace-header-menu-item-label">Delete dataset</span>
        </button>
      </div>,
      document.body,
    );

  const rowDetails = selectedRow && selectedIndex !== null && (
    <>
      <DetailsPaneHeader
        title={<span className="trace-row-name">Row {selectedIndex + 1}</span>}
        actions={
          <>
            {linkedPrompt && (
              <button
                type="button"
                className="dataset-row-btn"
                title={`Open in playground (${linkedPrompt.name})`}
                aria-label="Open row in playground"
                onClick={() => openInPlayground(selectedIndex)}
              >
                ▶
              </button>
            )}
            <button
              type="button"
              className="dataset-row-btn dataset-row-delete"
              title="Delete row"
              aria-label="Delete row"
              onClick={() =>
                void act(async () => {
                  await deleteDatasetRow(providerId, datasetId, selectedRow.id);
                  setSelection(NO_SELECTION);
                  setReload(n => n + 1);
                })
              }
            >
              <TrashIcon />
            </button>
          </>
        }
        id={selectedRow.id}
        onClose={() => setSelection(NO_SELECTION)}
      />
      <DatasetRowDetails
        dataset={dataset}
        row={selectedRow}
        onOpenTrace={onOpenTrace}
        onChangeCell={(fieldId, cell) =>
          saveCell(selectedRow.id, fieldId, cell)
        }
      />
    </>
  );

  return (
    <div className="dataset-view">
      <div className="trace-view-header dataset-view-header">
        <div className="trace-view-header-row">
          <div className="trace-view-title">
            {renaming ? (
              <form
                className="dataset-view-rename"
                onSubmit={e => {
                  e.preventDefault();
                  void submitRename();
                }}
              >
                <input
                  autoFocus
                  aria-label="Dataset name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onFocus={e => e.target.select()}
                  onBlur={() => setRenaming(false)}
                  onKeyDown={e => e.key === "Escape" && setRenaming(false)}
                />
              </form>
            ) : (
              <span
                className="trace-view-name"
                onDoubleClick={startRename}
                title="Double-click to rename"
              >
                {dataset.name}
              </span>
            )}
          </div>
          <div className="trace-view-header-actions">
            <div className="trace-view-header-actions-full">
              <button
                type="button"
                className="trace-view-prompt-btn trace-view-delete-btn"
                onClick={handleDelete}
                title="Delete dataset"
                aria-label="Delete dataset"
              >
                <TrashIcon />
              </button>
            </div>
            <button
              type="button"
              ref={menuTriggerRef}
              className="trace-view-header-menu-trigger"
              onClick={() => setMenuOpen(o => !o)}
              title="More actions"
              aria-label="More actions"
            >
              <MoreIcon />
            </button>
          </div>
        </div>
        <div className="trace-view-meta">
          <span className="trace-view-meta-item" title="Last updated">
            <CalendarIcon />
            <span className="trace-view-date-full">
              {formatTimestamp(dataset.updatedAt)}
            </span>
            <span className="trace-view-date-compact">
              {formatTimestampCompact(dataset.updatedAt)}
            </span>
          </span>
          <span className="trace-view-meta-item" title="Row count">
            <DatasetsIcon />
            {rowCount} row{rowCount === 1 ? "" : "s"}
          </span>
          {linkedPrompt && (
            <button
              type="button"
              className="trace-view-meta-item trace-view-prompt-link"
              onClick={() => onOpenPrompt(linkedPrompt)}
              title="Open the linked prompt"
            >
              <PromptLinkIcon />
              <span className="trace-view-prompt-link-name">
                {linkedPrompt.name}
              </span>
              ↗
            </button>
          )}
        </div>
      </div>
      {menu}
      {createPortal(
        // Glide draws a cell's editor over the canvas, into this layer: at
        // the viewport's origin, above everything, and placed from the
        // cell's on-screen position.
        <div ref={editorPortalRef} className="dataset-grid-portal" />,
        document.body,
      )}
      {error && (
        <div className="pg-exec-error dataset-view-action-error">
          {error}
          <button
            type="button"
            className="pg-dismiss"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      )}
      {linkedPrompt && stale.length > 0 && (
        <div className="dataset-view-stale">
          {stale.length} field{stale.length === 1 ? "" : "s"} no longer match{" "}
          <code>{linkedPrompt.name}</code>'s parameters:{" "}
          {stale.map((f, i) => (
            <span key={f.id}>
              {i > 0 && ", "}
              <code>{f.def.name}</code>
            </span>
          ))}
        </div>
      )}
      <div className="trace-view-body dataset-view-body" ref={bodyRef}>
        <div className="trace-view-main-column">
          {/*
           * Drawn even with no rows, so the header's "＋" can add a field to
           * an empty dataset and the trailing row can add its first row.
           */}
          <div className="dataset-grid" ref={gridRef}>
            <DataEditorCore
              renderers={RENDERERS}
              imageWindowLoader={NO_IMAGES}
              headerIcons={GRID_HEADER_ICONS}
              getGroupDetails={getGroupDetails}
              width="100%"
              height="100%"
              theme={theme}
              columns={gridColumns}
              rows={rowCount}
              trailingRowOptions={trailingRow}
              onRowAppended={canAppend ? onRowAppended : undefined}
              getCellContent={getCellContent}
              onVisibleRegionChanged={onVisibleRegionChanged}
              drawHeader={drawHeader}
              rowMarkers="clickable-number"
              rowSelect="single"
              rangeSelect="rect"
              columnSelect="none"
              gridSelection={selection}
              onGridSelectionChange={setSelection}
              onCellClicked={onCellClicked}
              onGroupHeaderClicked={onGroupHeaderClicked}
              onCellsEdited={onCellsEdited}
              validateCell={validateCell}
              onDelete={onDelete}
              // Split a pasted block over the cells from the selected one
              // on. Left unset, Glide pastes the whole clipboard into the
              // one selected cell.
              onPaste
              // Read cells out through `getCellContent`, which copying and
              // the fill handle both need.
              getCellsForSelection
              fillHandle
              onColumnResize={(column, width) =>
                column.id &&
                updateLayout({
                  ...layout,
                  widths: { ...widths, [column.id]: width },
                })
              }
              rowHeight={ROW_HEIGHT}
              headerHeight={HEADER_HEIGHT}
              groupHeaderHeight={GROUP_HEADER_HEIGHT}
              smoothScrollX
              smoothScrollY
              // Glide types this ref as never null.
              portalElementRef={editorPortalRef as RefObject<HTMLElement>}
              rightElement={
                <DatasetAddField
                  providerId={providerId}
                  datasetId={datasetId}
                  prompts={prompts}
                  linked={dataset.prompt}
                  top={grouped ? GROUP_HEADER_HEIGHT : 0}
                  height={HEADER_HEIGHT}
                  onAdded={() => setReload(n => n + 1)}
                />
              }
              // Filled rather than spaced, so the "＋" follows the last
              // column; not sticky, so it scrolls with the rest of the grid
              rightElementProps={{ sticky: false, fill: true }}
            />
            {/*
             * Glide rules the whole canvas, not just the rows: its
             * horizontal lines are drawn past the last row and its vertical
             * ones run the full height. Covering what's below the last row
             * ends the table there, while the grid still fills the pane so
             * the horizontal scrollbar stays at the bottom. Sits under the
             * scroller (see `styles.css`) so that scrollbar stays visible.
             */}
            <div className="dataset-grid-fill" style={{ top: contentBottom }}>
              {rowCount === 0 && !canAppend && (
                <p className="dataset-grid-empty">
                  No fields yet. Add one with the “＋” to start filling this
                  dataset in by hand.
                </p>
              )}
            </div>
          </div>
          {!showSidePane && rowDetails && (
            <DetailsPane placement="bottom" label="Row details">
              {rowDetails}
            </DetailsPane>
          )}
        </div>
        {showSidePane && rowDetails && (
          <DetailsPane placement="side" label="Row details">
            {rowDetails}
          </DetailsPane>
        )}
      </div>
    </div>
  );
}

export default DatasetView;
