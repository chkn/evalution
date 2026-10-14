// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { AgentInfo } from "../../shared/agent";
import { AskAgentButton, AskAgentMenuItems } from "./AskAgentButton";
import "@glideapps/glide-data-grid/dist/index.css";
import {
  booleanCellRenderer,
  bubbleCellRenderer,
  CompactSelection,
  DataEditorCore,
  type DataEditorRef,
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
import {
  type ColumnPath,
  columnPathId,
  pathField,
} from "../../shared/column-paths";
import type {
  Dataset,
  DatasetField,
  DatasetRow,
  DatasetRowsOverview,
  DatasetRowUpdate,
  NormalizedPrompt,
  PromptID,
} from "../../shared/types";
import {
  danglingReferences,
  describeReference,
} from "../../views/datasets/index.ts";
import { ViewChannel } from "../../views/host.ts";
import {
  type DatasetViewContext,
  datasetSurface,
} from "../../views/surfaces/datasets.ts";
import {
  addDatasetRows,
  deleteDataset,
  deleteDatasetField,
  deleteDatasetRow,
  describeDatasetPath,
  getDataset,
  getDatasetRows,
  renameDataset,
  renameDatasetField,
  setDatasetColumns,
  updateDatasetRows,
} from "../api";
import { useStructurallyStable } from "../hooks/useStructurallyStable";
import { DatasetAddColumn, type NewFieldConfig } from "./DatasetAddColumn";
import { DatasetColumnMenu } from "./DatasetColumnMenu";
import { DatasetColumnPicker } from "./DatasetColumnPicker";
import { DatasetRowDetails } from "./DatasetRowDetails";
import { DetailsPane, DetailsPaneHeader, useIsWide } from "./DetailsPane";
import { DatasetRowList } from "./dataset/DatasetRowList.tsx";
import { RowDraftBar } from "./dataset/RowDraftBar.tsx";
import {
  draftBase,
  draftRow,
  foldDraft,
  hasChanges,
  isStale,
  type RowDraft,
} from "./dataset/row-draft.ts";
import {
  addColumn,
  type ColumnLayout,
  reconcileColumns,
  removeColumn,
  serializeColumns,
  setHidden,
  slotPath,
} from "./dataset-columns";
import {
  buildColumns,
  type CellEdit,
  type CellView,
  canMoveColumn,
  cellEdits,
  cellView,
  clearEdits,
  columnPath,
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
  layoutWithoutField,
  menuFieldId,
  movedLayout,
  parseDatasetLayout,
  RowPager,
  rowLabelText,
  serializeDatasetLayout,
} from "./dataset-grid";
import { datasetInputSources, duplicateRow } from "./dataset-row-editing";
import { GRID_HEADER_ICONS } from "./grid-sprites";
import type { NewEvalSeed } from "./NewEvalDialog";
import {
  fromRow,
  type PanelFill,
  panelFill,
  staleFields,
} from "./named-inputs";
import { scrollToInstance } from "./ResourcesSection";
import { formatTimestamp, formatTimestampCompact } from "./trace/format.ts";
import {
  CalendarIcon,
  CopyIcon,
  DatasetsIcon,
  EvalsIcon,
  MoreIcon,
  PromptLinkIcon,
  SidePaneIcon,
  TrashIcon,
} from "./trace/icons.tsx";
import { useAnchoredPopover } from "./use-anchored-popover";
import { useContentRectTest } from "./use-content-rect-test";
import { GRID_MONO_FONT, useGridTheme } from "./use-grid-theme";
import {
  fallbackLabel,
  rememberedTab,
  rememberTab,
  useSurfaceViews,
} from "./views/use-surface-views.tsx";
import type { AcceptedAction } from "./views/ViewFrame.tsx";
import { ViewProblemsButton, ViewTabButtons } from "./views/ViewTabs.tsx";

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
  /** "New eval…" — opens the dialog with this dataset and its linked prompt chosen. */
  onNewEval?: (seed: NewEvalSeed) => void;
  /** Coding agents the "Ask" button offers. */
  agents?: readonly AgentInfo[];
  /**
   * Launches a coding agent about this dataset. Without it (or without
   * `agents`), there's no "Ask" button.
   */
  onAskAgent?: (agent: AgentInfo) => void;
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

/**
 * How long a cell must stay selected before it first opens the details pane.
 * Glide starts a cell's editor on a second click, so the first click of a
 * double-click would otherwise open the pane — shifting the grid — just as the
 * cell is being typed into. A click's pause is about this long.
 */
const PANE_DELAY_MS = 300;

const NO_PROMPTS: readonly NormalizedPrompt[] = [];
const NO_AGENTS: readonly AgentInfo[] = [];

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
    case "unknown":
      return text("", {
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
  onNewEval,
  agents = NO_AGENTS,
  onAskAgent,
}: Props) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [overview, setOverview] = useState<DatasetRowsOverview>({
    rowCount: 0,
    fields: {},
    instances: {},
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
  const editorRef = useRef<DataEditorRef>(null);

  // Tabs: Grid, and a tab per dataset view that applies. The last one is
  // remembered per dataset. See `specs/dataset-views.md` §C.
  const tabKey = `evalution.datasetTab:${providerId}/${datasetId}`;
  const [chosenTab, setChosenTab] = useState<string>(
    () => rememberedTab(tabKey) ?? "grid",
  );
  const tabKeyRef = useRef(tabKey);
  useEffect(() => {
    if (tabKeyRef.current === tabKey) return;
    tabKeyRef.current = tabKey;
    setChosenTab(rememberedTab(tabKey) ?? "grid");
  }, [tabKey]);
  /** The row a view tab shows, and the pane edits, while a view tab is active. */
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  /**
   * Whether the details pane is open, in every tab — separate from the grid's
   * selection, which only picks its row. When this is `undefined`, selecting a row in
   * the grid opens it. Explicitly closing it sets this to `false` so it doesn't reopen.
   */
  const [paneOpen, setPaneOpen] = useState<boolean | undefined>();
  /** An instance a view asked to have shown in the details pane, until the pane has rendered it. */
  const [reveal, setReveal] = useState<string | null>(null);
  /** A view's unsaved changes to the row it's showing. */
  const [draft, setDraft] = useState<RowDraft | undefined>();
  // What every dataset view's frame is told: this dataset, and the selected row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one channel per dataset.
  const channel = useMemo(
    () =>
      new ViewChannel(datasetSurface, {
        selected: null,
      } as DatasetViewContext),
    [providerId, datasetId],
  );
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
  /** The column header menu that's open: its column, and where it opened from. */
  const [columnMenu, setColumnMenu] = useState<{
    columnId: string;
    anchor: Rectangle;
  } | null>(null);
  const closeColumnMenu = useCallback(() => setColumnMenu(null), []);
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
  /** Loads a range of rows: what the view tabs' row list pages through. */
  const ensureRows = useCallback(
    (start: number, end: number) => pager.ensure(start, end),
    [pager],
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
      .then(({ dataset, rowCount, fields, instances }) => {
        if (cancelled) return;
        setDataset(dataset);
        setOverview({
          rowCount: rowCount + pendingAppends.current.count,
          fields,
          instances: instances ?? {},
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

  useEffect(() => {
    if (dataset) channel.setSubject({ dataset, overview });
  }, [channel, dataset, overview]);

  const linkedPrompt = dataset?.prompt ? findPrompt(dataset.prompt) : undefined;
  // The linked prompt's resources, offered on the fields that match its
  // parameters. Stable while their content is, so typing in the details pane
  // doesn't remount its editors.
  const rowSources = useStructurallyStable(
    dataset ? datasetInputSources(dataset.fields, linkedPrompt) : undefined,
  );

  /** The dataset's shared column layout, fitted to its fields and rows. */
  const columnLayout = useMemo(
    () =>
      dataset
        ? reconcileColumns(dataset.columns, dataset.fields, overview.fields)
        : [],
    [dataset, overview.fields],
  );
  const columns = useMemo(
    () =>
      dataset
        ? buildColumns({
            fields: dataset.fields,
            layout: columnLayout,
            expanded,
            shortType: syntax => shortSyntax(syntax, 24),
          })
        : [],
    [dataset, columnLayout, expanded],
  );
  const rowLabel = dataset?.rowLabel;

  /**
   * Writes the shared layout and row label (`null` clears the label; left
   * out, it stays as it is). Optimistic, as a cell edit is:
   * the grid redraws at once, and the `dataset-changed` refetch confirms. A
   * failure says why and reloads the dataset as the server has it.
   */
  const saveColumns = useCallback(
    (next: ColumnLayout, label: ColumnPath | null = rowLabel ?? null) => {
      const serialized = serializeColumns(next);
      setDataset(d => {
        if (!d) return d;
        const { rowLabel: _, ...rest } = d;
        return {
          ...rest,
          columns: serialized,
          ...(label && { rowLabel: label }),
        };
      });
      setDatasetColumns(providerId, datasetId, serialized, label).catch(
        (err: Error) => {
          setError(`Couldn't save the columns: ${err.message}`);
          setReload(n => n + 1);
        },
      );
    },
    [providerId, datasetId, rowLabel],
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
        hasMenu: true,
        ...(c.group !== undefined && { group: c.group }),
        ...(c.role === "unknown" && {
          themeOverride: { textHeader: theme.textLight },
        }),
      })),
    [columns, widths, theme],
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
      // Scrolled: the header the menu opened from has moved out from under it.
      setColumnMenu(null);
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

  // The grid's row is the selected cell's, or the row selected by its marker.
  // A selected cell stays a cell selection — not folded into its row — so it
  // can be typed into, pasted over, and cleared.
  const selectedIndex =
    selection.current?.cell[1] ?? selection.rows.first() ?? null;
  const gridIndex =
    selectedIndex !== null && selectedIndex < overview.rowCount
      ? selectedIndex
      : null;
  const loadedRow = gridIndex !== null ? pager.get(gridIndex) : undefined;
  // The pane keeps showing its row even once the pager drops that row's page
  // (scrolled far away) — until another row is selected.
  const shownRef = useRef<{ index: number; row: DatasetRow } | null>(null);
  if (loadedRow && gridIndex !== null) {
    shownRef.current = { index: gridIndex, row: loadedRow };
  }
  const gridRow =
    loadedRow ??
    (gridIndex !== null && shownRef.current?.index === gridIndex
      ? shownRef.current.row
      : undefined);

  // A cell selected while the pane hasn't been opened or closed opens it,
  // after waiting out PANE_DELAY_MS — which the cell's editor starting cuts
  // short. A row selected by its marker opens it at once. Clearing the
  // selection closes an open pane, to open again on the next one; a pane
  // closed by hand stays closed.
  const paneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(paneTimer.current), []);
  const onGridSelectionChange = useCallback(
    (next: GridSelection) => {
      setSelection(next);
      clearTimeout(paneTimer.current);
      if (!next.current && next.rows.length === 0) {
        setPaneOpen(open => (open ? undefined : open));
      } else if (paneOpen !== undefined) {
        return;
      } else if (next.rows.length > 0) {
        setPaneOpen(true);
      } else {
        paneTimer.current = setTimeout(
          () => setPaneOpen(open => open ?? true),
          PANE_DELAY_MS,
        );
      }
    },
    [paneOpen],
  );

  // #region Dataset views (`specs/dataset-views.md` §C, §D)

  /** The draft, current between renders: proposals can arrive back to back. */
  const draftRef = useRef(draft);
  const updateDraft = (next: RowDraft | undefined) => {
    draftRef.current = next;
    setDraft(next);
  };
  const viewRow =
    viewIndex !== null && viewIndex < overview.rowCount
      ? pager.get(viewIndex)
      : undefined;

  /** Asks before leaving a view's unsaved changes behind; whether to go on. */
  const leaveDraft = (): boolean => {
    const current = draftRef.current;
    if (!hasChanges(current)) {
      if (current) updateDraft(undefined);
      return true;
    }
    if (!window.confirm("Discard the unsaved changes to this row?")) {
      return false;
    }
    updateDraft(undefined);
    return true;
  };
  const selectViewRow = (index: number) => {
    if (index === viewIndex || !leaveDraft()) return;
    setViewIndex(index);
  };

  /** A visible view's action, its surface's checks passed. */
  const onViewAction = (action: AcceptedAction): string | undefined => {
    switch (action.name) {
      case "selectRow":
        selectViewRow((action.args as { index: number }).index);
        return undefined;
      case "showInstance": {
        const { name } = action.args as { name: string };
        // The pane shows the stored row, which a draft may have added to.
        if (!viewRow || !Object.hasOwn(viewRow.resources ?? {}, name)) {
          return `the row has no stored instance ${name}`;
        }
        setPaneOpen(true);
        setReveal(name);
        return undefined;
      }
      case "proposeUpdate": {
        const { update } = action.args as { update: DatasetRowUpdate };
        if (!viewRow || viewRow.id !== update.rowId) {
          return "the row isn't loaded";
        }
        const current = draftRef.current;
        const next = foldDraft(
          current?.rowId === viewRow.id ? current : undefined,
          viewRow,
          update,
        );
        const dangling = danglingReferences(draftRow(next));
        if (dangling.length > 0) {
          return `That would leave references to instances the row doesn't declare: ${dangling.map(describeReference).join("; ")}`;
        }
        updateDraft(next);
        return undefined;
      }
      default:
        return `no action ${action.name}`;
    }
  };

  const views = useSurfaceViews({
    surface: datasetSurface,
    channel,
    activeUri: chosenTab.startsWith("view:") ? chosenTab.slice(5) : null,
    onAction: onViewAction,
  });
  const inView = views.shownUri !== null;
  // Scroll to a requested instance once the pane has rendered its card.
  useEffect(() => {
    if (!reveal) return;
    scrollToInstance(reveal);
    setReveal(null);
  }, [reveal]);
  const viewLabel =
    views.tabs.find(t => t.uri === views.shownUri)?.label ??
    fallbackLabel(views.shownUri ?? "");

  // A view tab always has a row to show, unless there are none.
  useEffect(() => {
    if (!inView) return;
    const { rowCount } = overview;
    if (rowCount === 0) setViewIndex(null);
    else if (viewIndex === null) setViewIndex(0);
    else if (viewIndex >= rowCount) setViewIndex(rowCount - 1);
  }, [inView, viewIndex, overview]);
  useEffect(() => {
    if (inView && viewIndex !== null) {
      pager.ensure(viewIndex, Math.min(viewIndex + 1, overview.rowCount));
    }
  }, [inView, viewIndex, pager, overview.rowCount]);

  // The selected row, shared by every tab: the grid's in Grid, else the
  // view's — with the view's unsaved changes applied.
  const contextIndex = inView ? viewIndex : gridIndex;
  const contextStored = inView ? viewRow : gridRow;
  const contextRow = useMemo(
    () =>
      contextStored && draft?.rowId === contextStored.id
        ? draftRow(draft)
        : contextStored,
    [contextStored, draft],
  );
  const contextLabel =
    contextRow && rowLabel ? rowLabelText(contextRow, rowLabel) : undefined;
  // What the row was before the draft, while the draft changes anything.
  const contextBase = contextStored && draftBase(draft, contextStored.id);
  useEffect(() => {
    channel.setContext({
      selected:
        contextRow && contextIndex !== null
          ? {
              index: contextIndex,
              row: contextRow,
              ...(contextBase && { stored: contextBase }),
              ...(contextLabel !== undefined && { label: contextLabel }),
            }
          : null,
    });
  }, [channel, contextRow, contextIndex, contextLabel, contextBase]);

  const chooseTab = (tab: string) => {
    if (tab === chosenTab || !leaveDraft()) return;
    if (tab.startsWith("view:") && !inView) {
      // The grid's row carries over.
      setViewIndex(gridIndex);
    } else if (tab === "grid" && inView && viewIndex !== null) {
      // The view's row carries over, selected as a row the marker selects.
      setSelection({
        columns: CompactSelection.empty(),
        rows: CompactSelection.fromSingleSelection(viewIndex),
      });
      setPaneOpen(open => open ?? true);
      const row = viewIndex;
      requestAnimationFrame(() => editorRef.current?.scrollTo(0, row));
    }
    setChosenTab(tab);
    rememberTab(tabKey, tab);
  };

  const saveDraft = () => {
    const current = draftRef.current;
    if (!current) return;
    if (!viewRow || viewRow.id !== current.rowId || isStale(current, viewRow)) {
      setError("This row changed since you started; discard and redo.");
      return;
    }
    updateDraft(undefined);
    // Refused: bring the draft back, unless another has been started since.
    // The row reloads as it was stored, so it isn't stale.
    void saveUpdates([current.update]).then(saved => {
      if (!saved && !draftRef.current) updateDraft(current);
    });
  };
  const draftPending =
    inView && hasChanges(draft) && viewRow?.id === draft.rowId;
  const draftStale =
    !!draft &&
    !!viewRow &&
    viewRow.id === draft.rowId &&
    isStale(draft, viewRow);

  // #endregion

  const openInPlayground = (index: number) => {
    const row = pager.get(index);
    if (!dataset || !linkedPrompt || !row) return;
    onOpenInPlayground(
      linkedPrompt,
      panelFill(
        fromRow(dataset, row),
        linkedPrompt,
        {
          type: "dataset",
          description: `${dataset.name}, row ${index + 1}`,
          providerId,
          datasetId,
          name: dataset.name,
        },
        row.resources,
      ),
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
   * Settles to whether the server took the updates.
   */
  const saveUpdates = useCallback(
    async (updates: DatasetRowUpdate[]): Promise<boolean> => {
      if (updates.length === 0) return true;
      pager.patch(updates);
      setLoaded(n => n + 1);
      try {
        await updateDatasetRows(providerId, datasetId, updates);
        return true;
      } catch (err) {
        setError(`Couldn't save: ${(err as Error).message}`);
        pager.invalidate();
        const { start, end } = visibleRef.current;
        pager.ensure(start, Math.min(end, overview.rowCount));
        // A view tab's row is shown with the grid hidden.
        if (viewIndex !== null) pager.ensure(viewIndex, viewIndex + 1);
        return false;
      }
    },
    [pager, providerId, datasetId, overview.rowCount, viewIndex],
  );
  const saveEdits = useCallback(
    (edits: CellEdit[]) => saveUpdates(groupEdits(edits)),
    [saveUpdates],
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

  /**
   * A cell's editor is opening (a double-click, Enter): the row isn't wanted
   * beside it, so a pane still waiting to open for the cell doesn't.
   */
  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      if (editableCell(pager.get(row), columns[col])) {
        clearTimeout(paneTimer.current);
      }
    },
    [columns, pager],
  );

  const onGroupHeaderClicked = useCallback(
    (col: number, event: { preventDefault: () => void }) => {
      const column = columns[col];
      const fieldId =
        column && "path" in column ? pathField(column.path) : undefined;
      if (fieldId === undefined) return;
      event.preventDefault();
      const next = new Set(expanded);
      if (!next.delete(fieldId)) next.add(fieldId);
      updateLayout({ ...layout, expanded: next });
    },
    [columns, expanded, layout, updateLayout],
  );

  const onHeaderMenuClick = useCallback(
    (col: number, anchor: Rectangle) => {
      const column = columns[col];
      if (column) setColumnMenu({ columnId: column.id, anchor });
    },
    [columns],
  );

  /** Refuses a header drag that would split a field's keys up (§Q.3). */
  const onColumnProposeMove = useCallback(
    (from: number, to: number) => canMoveColumn(columns, from, to),
    [columns],
  );

  /** A header was dragged to a new place: one write, on drop. */
  const onColumnMoved = useCallback(
    (from: number, to: number) => {
      const next = movedLayout(columnLayout, columns, from, to);
      if (next !== columnLayout) saveColumns(next);
    },
    [columnLayout, columns, saveColumns],
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

  const menuColumn = columnMenu
    ? columns.find(c => c.id === columnMenu.columnId)
    : undefined;
  const menuFieldIdValue = menuFieldId(menuColumn);
  const menuField =
    menuFieldIdValue !== undefined
      ? dataset.fields.find(f => f.id === menuFieldIdValue)
      : undefined;
  const menuPath = columnPath(menuColumn);
  const labelId = rowLabel && columnPathId(rowLabel);

  const renameField = async (field: DatasetField, name: string) => {
    const renamed = await renameDatasetField(
      providerId,
      datasetId,
      field.id,
      name,
    );
    setDataset({
      ...dataset,
      fields: dataset.fields.map(f => (f.id === renamed.id ? renamed : f)),
    });
    setReload(n => n + 1);
  };

  const handleDeleteField = (field: DatasetField) => {
    setColumnMenu(null);
    if (
      !window.confirm(
        `Delete the field “${field.def.name}” and its values in every row?`,
      )
    )
      return;
    void act(async () => {
      await deleteDatasetField(providerId, datasetId, field.id);
      updateLayout(layoutWithoutField(layout, field.id));
      onGridSelectionChange(NO_SELECTION);
      setReload(n => n + 1);
    });
  };

  const describeColumnPath = (path: ColumnPath) =>
    describeDatasetPath(providerId, datasetId, path);
  const addColumnAt = (path: ColumnPath) =>
    saveColumns(addColumn(columnLayout, path));
  const reloadFields = () => setReload(n => n + 1);
  /** What "New field", in both places that add a column, adds a field with. */
  const newField: NewFieldConfig = {
    providerId,
    datasetId,
    prompts,
    ...(dataset.prompt && { linked: dataset.prompt }),
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
        {onNewEval && (
          <button
            type="button"
            className="trace-header-menu-item"
            onClick={() => {
              setMenuOpen(false);
              newEval();
            }}
          >
            <span className="trace-header-menu-item-icon">
              <EvalsIcon size={14} />
            </span>
            <span className="trace-header-menu-item-label">New eval…</span>
          </button>
        )}
        {onAskAgent && (
          <AskAgentMenuItems
            // Only those that can run: the button's own menu is where the
            // rest, and "Other", are offered.
            agents={agents.filter(agent => !agent.disabledReason)}
            onAsk={agent => {
              setMenuOpen(false);
              onAskAgent(agent);
            }}
          />
        )}
        {(onNewEval || onAskAgent) && <hr className="ask-agent-menu-divider" />}
        <button
          type="button"
          className="trace-header-menu-item dataset-menu-delete"
          onClick={() => {
            setMenuOpen(false);
            handleDelete();
          }}
        >
          <span className="trace-header-menu-item-icon">
            <TrashIcon />
          </span>
          <span className="trace-header-menu-item-label">Delete dataset</span>
        </button>
      </div>,
      document.body,
    );

  const newEval = () =>
    onNewEval?.({
      dataset: { providerId, id: datasetId },
      ...(linkedPrompt?.providerId && {
        prompt: { id: linkedPrompt.id, providerId: linkedPrompt.providerId },
      }),
    });

  // While it's open, the pane shows the grid's row in Grid, else the view's.
  const paneIndex = paneOpen ? (inView ? viewIndex : gridIndex) : null;
  const paneRow = paneOpen ? (inView ? viewRow : gridRow) : undefined;
  const selectedLabel =
    paneRow && rowLabel ? rowLabelText(paneRow, rowLabel) : undefined;

  /**
   * Appends a copy of `row` (see {@link duplicateRow}) and, in the grid,
   * selects it — the pane follows to the copy, which is where an edit to it
   * would start.
   */
  const duplicateRowAt = (row: DatasetRow) =>
    act(async () => {
      const at = overview.rowCount;
      await addDatasetRows(providerId, datasetId, [duplicateRow(row)]);
      setReload(n => n + 1);
      if (!inView) {
        setSelection({
          columns: CompactSelection.empty(),
          rows: CompactSelection.fromSingleSelection(at),
        });
        requestAnimationFrame(() => editorRef.current?.scrollTo(0, at));
      }
    });

  /**
   * Shows or hides the details pane — for good: selecting a row no longer
   * opens it. Opened in the grid with nothing selected, it selects the row it
   * last showed (`shownRef` outlives the selection), or the first.
   */
  const togglePane = () => {
    setPaneOpen(!paneOpen);
    if (paneOpen || inView || selectedIndex !== null) return;
    const at = Math.min(shownRef.current?.index ?? 0, rowCount - 1);
    setSelection({
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromSingleSelection(at),
    });
    editorRef.current?.scrollTo(0, at);
  };

  const rowDetails = paneRow && paneIndex !== null && (
    <>
      <DetailsPaneHeader
        title={
          <span className="trace-row-name">
            Row {paneIndex + 1}
            <code className="dataset-row-id"> · {paneRow.id}</code>
          </span>
        }
        subtitle={selectedLabel}
        actions={
          <>
            {linkedPrompt && (
              <button
                type="button"
                className="dataset-row-btn"
                title={`Open in playground (${linkedPrompt.name})`}
                aria-label="Open row in playground"
                onClick={() => openInPlayground(paneIndex)}
              >
                ▶
              </button>
            )}
            <button
              type="button"
              className="dataset-row-btn"
              title="Duplicate row"
              aria-label="Duplicate row"
              onClick={() => void duplicateRowAt(paneRow)}
            >
              <CopyIcon />
            </button>
            <button
              type="button"
              className="dataset-row-btn dataset-row-delete"
              title="Delete row"
              aria-label="Delete row"
              onClick={() =>
                void act(async () => {
                  await deleteDatasetRow(providerId, datasetId, paneRow.id);
                  // A view tab's pane moves on to the row in its place.
                  if (inView) setSelection(NO_SELECTION);
                  else onGridSelectionChange(NO_SELECTION);
                  if (draftRef.current?.rowId === paneRow.id) {
                    updateDraft(undefined);
                  }
                  setReload(n => n + 1);
                })
              }
            >
              <TrashIcon />
            </button>
          </>
        }
      />
      {hasChanges(draft) && draft.rowId === paneRow.id && (
        <div className="dataset-row-draft-banner">
          {viewLabel} has unsaved changes to this row. Edits here are saved at
          once, and will leave those changes stale.
        </div>
      )}
      <DatasetRowDetails
        dataset={dataset}
        row={paneRow}
        onOpenTrace={onOpenTrace}
        onChangeRow={update => saveUpdates([{ rowId: paneRow.id, ...update }])}
        sources={rowSources}
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
            <DatasetColumnPicker
              layout={columnLayout}
              fields={dataset.fields}
              instances={overview.instances}
              rowLabel={rowLabel}
              onChange={next => saveColumns(next)}
              onRowLabel={path => saveColumns(columnLayout, path ?? null)}
              onAdd={addColumnAt}
              onRemove={index => {
                const path = slotPath(columnLayout, { index });
                saveColumns(
                  removeColumn(columnLayout, index),
                  path && columnPathId(path) === labelId
                    ? null
                    : (rowLabel ?? null),
                );
              }}
              describePath={describeColumnPath}
              newField={newField}
              onFieldAdded={reloadFields}
            />
            <div className="trace-view-header-actions-full">
              {onNewEval && (
                <button
                  type="button"
                  className="trace-view-prompt-btn"
                  onClick={newEval}
                  title="New eval on this dataset"
                >
                  <EvalsIcon size={14} />
                  New eval…
                </button>
              )}
              {onAskAgent && (
                <AskAgentButton agents={agents} onAsk={onAskAgent} />
              )}
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
      {columnMenu && menuColumn && (
        <DatasetColumnMenu
          key={menuColumn.id}
          {...(menuField && { field: menuField })}
          anchor={columnMenu.anchor}
          onRename={async name => {
            if (menuField) await renameField(menuField, name);
          }}
          onDelete={() => menuField && handleDeleteField(menuField)}
          onHide={() =>
            saveColumns(setHidden(columnLayout, menuColumn.slot, true))
          }
          {...(menuPath && {
            rowLabel: {
              isLabel: columnPathId(menuPath) === labelId,
              toggle: () =>
                saveColumns(
                  columnLayout,
                  columnPathId(menuPath) === labelId ? null : menuPath,
                ),
            },
          })}
          onClose={closeColumnMenu}
        />
      )}
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
          <div className="trace-view-tabs dataset-view-tabs">
            <div className="trace-view-tab-list">
              <button
                type="button"
                className={`trace-view-tab${inView ? "" : " trace-view-tab-active"}`}
                onClick={() => chooseTab("grid")}
              >
                <DatasetsIcon />
                Grid
              </button>
              <ViewTabButtons
                tabs={views.tabs}
                active={views.shownUri}
                onSelect={uri => chooseTab(`view:${uri}`)}
              />
              <ViewProblemsButton problems={views.problems} />
            </div>
            <button
              type="button"
              className={`dataset-pane-toggle${paneOpen ? " dataset-pane-toggle-active" : ""}`}
              onClick={togglePane}
              disabled={rowCount === 0}
              title="Row details"
              aria-label="Row details"
              aria-pressed={!!paneOpen}
            >
              <SidePaneIcon />
            </button>
          </div>
          {draftPending && (
            <RowDraftBar
              viewLabel={viewLabel}
              rowName={`Row ${(viewIndex ?? 0) + 1}`}
              stale={draftStale}
              onSave={saveDraft}
              onDiscard={() => updateDraft(undefined)}
            />
          )}
          <div className="dataset-view-main">
            {inView && (
              <DatasetRowList
                rowCount={rowCount}
                getRow={i => pager.get(i)}
                ensure={ensureRows}
                label={row =>
                  rowLabel ? rowLabelText(row, rowLabel) : undefined
                }
                selected={viewIndex}
                onSelect={selectViewRow}
              />
            )}
            <div className="view-stack">
              {/*
               * Drawn even with no rows, so the header's "＋" can add a field to
               * an empty dataset and the trailing row can add its first row.
               */}
              <div
                className="dataset-grid"
                ref={gridRef}
                style={inView ? { display: "none" } : undefined}
              >
                <DataEditorCore
                  ref={editorRef}
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
                  onGridSelectionChange={onGridSelectionChange}
                  onCellClicked={onCellClicked}
                  onCellActivated={onCellActivated}
                  onGroupHeaderClicked={onGroupHeaderClicked}
                  onHeaderMenuClick={onHeaderMenuClick}
                  onColumnProposeMove={onColumnProposeMove}
                  onColumnMoved={onColumnMoved}
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
                    <DatasetAddColumn
                      fields={dataset.fields}
                      instances={overview.instances}
                      describePath={describeColumnPath}
                      onPick={addColumnAt}
                      newField={newField}
                      onFieldAdded={reloadFields}
                      top={grouped ? GROUP_HEADER_HEIGHT : 0}
                      height={HEADER_HEIGHT}
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
                <div
                  className="dataset-grid-fill"
                  style={{ top: contentBottom }}
                >
                  {rowCount === 0 && !canAppend && (
                    <p className="dataset-grid-empty">
                      No fields yet. Add one with the “＋” to start filling this
                      dataset in by hand.
                    </p>
                  )}
                </div>
              </div>
              {inView && rowCount === 0 && (
                <div className="view-frame-message">No rows</div>
              )}
              {views.layer}
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
