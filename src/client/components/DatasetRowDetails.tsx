// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { shortSyntax } from "ts-proppy/react";
import type {
  Dataset,
  DatasetField,
  DatasetRow,
  ExecutionInput,
  PropValue,
  ResourceInfo,
} from "../../shared/types";
import { DetailRow, type Fact, FactGroup, FactsGrid } from "./DetailsPane";
import { previewCell, propValueToJson, resourceName } from "./dataset-preview";
import {
  chosenResources,
  type DatasetInputSources,
  type RowEditorState,
  rowCellChanges,
  rowEditorState,
} from "./dataset-row-editing";
import { ExecutionInputEditor } from "./ExecutionInputEditor";
import { computeClaims } from "./resource-args-context";
import { formatTimestamp } from "./trace/format.ts";
import { CalendarIcon, SpansIcon } from "./trace/icons.tsx";
import { JsonView } from "./trace/JsonView.tsx";

/** A typed-in value in full: text wraps, structured data is a JSON tree. */
function ValueView({ value }: { value: PropValue }) {
  if (
    (value.kind === "primitive" && typeof value.value === "string") ||
    value.kind === "template"
  ) {
    return (
      <div className="dataset-detail-text">
        {propValueToJson(value) as string}
      </div>
    );
  }
  if (
    value.kind === "object" ||
    value.kind === "array" ||
    value.kind === "tuple"
  ) {
    return <JsonView data={propValueToJson(value)} />;
  }
  return (
    <code className="dataset-detail-scalar">
      {String(propValueToJson(value))}
    </code>
  );
}

/** Named inputs — an object's properties or a resource's arguments. */
function KeyedInputs({ inputs }: { inputs: Record<string, ExecutionInput> }) {
  return (
    <div className="dataset-detail-keys">
      {Object.entries(inputs).map(([key, input]) => (
        <div key={key} className="dataset-detail-key-row">
          <span className="dataset-detail-key">{key}</span>
          <InputView input={input} />
        </div>
      ))}
    </div>
  );
}

/**
 * A dataset cell in full: the one-line previews the table has room for,
 * expanded — long text to read, and a resource's arguments beneath it.
 */
export function InputView({ input }: { input: ExecutionInput }) {
  switch (input.kind) {
    case "value":
      return <ValueView value={input.value} />;
    case "object":
      return <KeyedInputs inputs={input.properties} />;
    case "resource":
      return (
        <div className="dataset-detail-resource">
          <span className="dataset-cell-chip" title={input.uri}>
            <span className="dataset-cell-chip-icon" aria-hidden>
              ◆
            </span>
            {resourceName(input.uri)}
          </span>
          {input.args && Object.keys(input.args).length > 0 && (
            <KeyedInputs inputs={input.args} />
          )}
        </div>
      );
    case "dataset":
    case "input":
      return (
        <code className="dataset-detail-scalar">{previewCell(input)}</code>
      );
  }
}

/** A stable stand-in for "no resources", so memos keyed on it hold. */
const NO_RESOURCES: ResourceInfo[] = [];

/**
 * A row's fields as the execute panel edits its slots: each in
 * `ExecutionInputEditor` against the field's `def`, offering whatever
 * resources `sources` maps onto it, with their arguments.
 *
 * Typed edits stay a local draft and are committed on blur, on Enter
 * (Shift+Enter still types a newline), or when the editor goes away, rather
 * than on every keystroke — each commit is a save. Choosing or dropping a
 * resource commits at once, as there's nothing more to type. A commit sends
 * every field whose cell changed, since a resource's arguments are shared by
 * every field that picked it.
 */
function RowFields({
  fields,
  row,
  sources,
  onChangeCells,
}: {
  fields: readonly DatasetField[];
  row: DatasetRow;
  sources: DatasetInputSources | undefined;
  onChangeCells?: (cells: Record<string, ExecutionInput | null>) => void;
}) {
  const resources = sources?.resources ?? NO_RESOURCES;
  const resourcesByUri = useMemo(
    () => new Map(resources.map(r => [r.uri, r])),
    [resources],
  );
  const [state, setState] = useState<RowEditorState>(() =>
    rowEditorState(row.cells, resourcesByUri),
  );
  const [dirty, setDirty] = useState(false);
  // New stored cells — the refetch after a save — replace a clean draft.
  const [stored, setStored] = useState(row.cells);
  if (stored !== row.cells) {
    setStored(row.cells);
    if (!dirty) setState(rowEditorState(row.cells, resourcesByUri));
  }

  // A resource or `object` cell is only editable with resources to offer:
  // without them it would read as a resource that's gone.
  const isEditable = (field: DatasetField) => {
    const input = row.cells[field.id];
    return !!onChangeCells && (!!sources || !input || input.kind === "value");
  };
  const editableIds = fields.filter(isEditable).map(f => f.id);

  const commit = (next: RowEditorState) => {
    setDirty(false);
    const changes = rowCellChanges(
      editableIds,
      next,
      row.cells,
      resourcesByUri,
    );
    if (Object.keys(changes).length > 0) onChangeCells?.(changes);
  };

  const update = (next: RowEditorState) => {
    setState(next);
    if (chosenResources(next) !== chosenResources(state)) commit(next);
    else setDirty(true);
  };

  // Selecting another row in the grid swaps this editor out (it's keyed by
  // row) without a blur: the focused textarea is simply removed. So a draft
  // still pending then is committed on the way out, to the row it was made
  // on — `onChangeCells` is bound to that row.
  const commitPending = () => {
    if (dirty) commit(state);
  };
  const commitRef = useRef(commitPending);
  commitRef.current = commitPending;
  useEffect(() => () => commitRef.current(), []);

  const claimed = useMemo(
    () =>
      computeClaims(
        fields.map(f => ({
          path: fieldPath(f),
          label: f.def.name,
          selection: state.selections[f.id],
        })),
        state.resourceArgs,
        resourcesByUri,
      ),
    [fields, state, resourcesByUri],
  );

  return fields.map(field => {
    const input = row.cells[field.id];
    return (
      <DetailRow
        key={field.id}
        label={
          <>
            <span className="dataset-detail-field">{field.def.name}</span>
            <span className="dataset-detail-type" title={field.def.type.syntax}>
              {shortSyntax(field.def.type.syntax, 32)}
            </span>
          </>
        }
      >
        <div className="dataset-detail-cell">
          {isEditable(field) ? (
            <div
              className="dataset-detail-editor"
              onBlur={(e: FocusEvent<HTMLDivElement>) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  commitPending();
                }
              }}
              onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                // An editor that used Enter itself — to pick a suggestion,
                // say — has already claimed it.
                if (
                  e.key !== "Enter" ||
                  e.shiftKey ||
                  e.defaultPrevented ||
                  e.nativeEvent.isComposing
                ) {
                  return;
                }
                e.preventDefault();
                commitPending();
              }}
            >
              <ExecutionInputEditor
                propDef={field.def}
                selection={state.selections[field.id] ?? {}}
                onChange={selection =>
                  update({
                    ...state,
                    selections: { ...state.selections, [field.id]: selection },
                  })
                }
                resources={resources}
                slots={sources?.fieldSlots[field.id] ?? {}}
                argsContext={
                  sources && {
                    resourceArgs: state.resourceArgs,
                    onResourceArgsChange: (uri, next) =>
                      update({
                        ...state,
                        resourceArgs: { ...state.resourceArgs, [uri]: next },
                      }),
                    resourceSlots: sources.resourceSlots,
                    claimed,
                    path: fieldPath(field),
                    depth: 0,
                  }
                }
              />
            </div>
          ) : input ? (
            <InputView input={input} />
          ) : (
            <span className="dataset-cell-empty">—</span>
          )}
          {onChangeCells && input && (
            <button
              type="button"
              className="dataset-detail-clear"
              title={`Clear ${field.def.name}`}
              aria-label={`Clear ${field.def.name}`}
              onClick={() => onChangeCells({ [field.id]: null })}
            >
              ×
            </button>
          )}
        </div>
      </DetailRow>
    );
  });
}

/** A field's row identity, for "same instance as" links between fields. */
function fieldPath(field: DatasetField): string {
  return `field.${field.id}`;
}

/**
 * One dataset row in the details pane: when it was added and where from,
 * then every field — the same facts-over-blocks layout as a span's details.
 *
 * With `onChangeCells`, every field is edited in place as the execute panel
 * edits a parameter, and any cell can be cleared. Resources are offered from
 * `sources` — the linked prompt's, since a dataset has none of its own.
 * Without them, a resource or `object` cell stays read-only. See
 * `specs/datasets.md` §P.2.
 */
export function DatasetRowDetails({
  dataset,
  row,
  onOpenTrace,
  onChangeCells,
  sources,
}: {
  dataset: Dataset;
  row: DatasetRow;
  onOpenTrace: (providerId: string, traceId: string) => void;
  /**
   * Sets fields' cells, by field id, or clears them with `null`. Read-only
   * without.
   */
  onChangeCells?: (cells: Record<string, ExecutionInput | null>) => void;
  /** The resources the fields can be filled from, if any. */
  sources?: DatasetInputSources;
}) {
  const facts: Fact[] = [
    {
      label: "Added",
      icon: <CalendarIcon />,
      value: formatTimestamp(row.createdAt),
    },
  ];
  const { source } = row;
  if (source) {
    facts.push({
      label: "Source",
      icon: <SpansIcon />,
      value:
        source.kind === "trace" ? (
          <button
            type="button"
            className="dataset-link-btn"
            onClick={() => onOpenTrace(source.traceProviderId, source.traceId)}
            title="Open the trace this row came from"
          >
            trace ↗
          </button>
        ) : (
          "playground"
        ),
    });
  }

  return (
    <div className="span-details">
      <div className="span-details-list">
        <FactsGrid>
          <FactGroup facts={facts} />
        </FactsGrid>
        <RowFields
          // Per row, so a draft never carries over to the next one.
          key={row.id}
          fields={dataset.fields}
          row={row}
          sources={sources}
          onChangeCells={onChangeCells}
        />
      </div>
    </div>
  );
}
