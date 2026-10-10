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
  DatasetRowUpdate,
  ExecutionInput,
  PromptInputSources,
  PropValue,
  ResourceInfo,
} from "../../shared/types";
import { DetailRow, type Fact, FactGroup, FactsGrid } from "./DetailsPane";
import { previewCell, propValueToJson, resourceName } from "./dataset-preview";
import {
  changesAnything,
  chosenResources,
  type DatasetInputSources,
  type RowEditorState,
  rowChanges,
  rowEditorState,
} from "./dataset-row-editing";
import { ExecutionInputEditor } from "./ExecutionInputEditor";
import { withInstanceResources, withInstanceSlots } from "./pseudo-sources";
import {
  type InstanceEdit,
  instanceSourceContext,
  ResourcesSection,
} from "./ResourcesSection";
import {
  adoptCatalogPick,
  type InstanceSelections,
  referencesTo,
  retargetSelections,
} from "./run-resources-state";
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

/** Named inputs — an object's properties or a resource instance's arguments. */
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
 * expanded — long text to read, and objects key by key.
 */
export function InputView({ input }: { input: ExecutionInput }) {
  switch (input.kind) {
    case "value":
      return <ValueView value={input.value} />;
    case "object":
      return <KeyedInputs inputs={input.properties} />;
    case "instance":
      return (
        <span className="dataset-cell-chip">
          <span className="dataset-cell-chip-icon" aria-hidden>
            ◆
          </span>
          {previewCell(input)}
        </span>
      );
    case "dataset":
    case "input":
      return (
        <code className="dataset-detail-scalar">{previewCell(input)}</code>
      );
    default:
      return (
        <span className="dataset-detail-scalar">{previewCell(input)}</span>
      );
  }
}

/** A stable stand-in for "no resources", so memos keyed on it hold. */
const NO_RESOURCES: ResourceInfo[] = [];

/** A row's resource instances, read-only: each with its resource and arguments. */
function RowResources({ row }: { row: DatasetRow }) {
  const entries = Object.entries(row.resources ?? {});
  if (entries.length === 0) return null;
  return (
    <DetailRow label={<span className="dataset-detail-field">Resources</span>}>
      <div className="dataset-detail-keys">
        {entries.map(([name, spec]) => (
          <div key={name} className="dataset-detail-key-row">
            <span className="dataset-detail-key">◆ {name}</span>
            <div className="dataset-detail-resource">
              <span className="dataset-cell-chip" title={spec.uri}>
                {resourceName(spec.uri)}
              </span>
              {spec.args && Object.keys(spec.args).length > 0 && (
                <KeyedInputs inputs={spec.args} />
              )}
            </div>
          </div>
        ))}
      </div>
    </DetailRow>
  );
}

/**
 * A row's resource instances and fields, as the execute panel edits its own:
 * the Resources section first, then each field in `ExecutionInputEditor`
 * against the field's `def`, offering the row's instances and whatever
 * resources `sources` maps onto it.
 *
 * Typed edits stay a local draft and are committed on blur, on Enter
 * (Shift+Enter still types a newline), or when the editor goes away, rather
 * than on every keystroke — each commit is a save. Choosing or dropping a
 * source, and adding, removing or renaming an instance, commits at once, as
 * there's nothing more to type. A commit sends every field and instance that
 * changed.
 */
function RowFields({
  fields,
  row,
  sources,
  onChangeRow,
}: {
  fields: readonly DatasetField[];
  row: DatasetRow;
  sources: DatasetInputSources | undefined;
  onChangeRow?: (update: Omit<DatasetRowUpdate, "rowId">) => void;
}) {
  const catalog = sources?.resources ?? NO_RESOURCES;
  const catalogByUri = useMemo(
    () => new Map(catalog.map(r => [r.uri, r])),
    [catalog],
  );
  const [state, setState] = useState<RowEditorState>(() => rowEditorState(row));
  // Updates apply to the latest state synchronously, not to the one this
  // render saw: a catalog pick adds an instance and binds it in one gesture.
  const stateRef = useRef(state);
  const [dirty, setDirty] = useState(false);
  // A new stored row — the refetch after a save — replaces a clean draft.
  const [stored, setStored] = useState(row);
  if (stored !== row) {
    setStored(row);
    if (!dirty) {
      const fresh = rowEditorState(row);
      stateRef.current = fresh;
      setState(fresh);
    }
  }

  // An instance or `object` cell is only editable with resources to offer:
  // without them it would read as a resource that's gone.
  const isEditable = (field: DatasetField) => {
    const input = row.cells[field.id];
    return !!onChangeRow && (!!sources || !input || input.kind === "value");
  };
  const editableIds = fields.filter(isEditable).map(f => f.id);

  const commit = (next: RowEditorState) => {
    setDirty(false);
    const changes = rowChanges(
      editableIds,
      sources ? next : { ...next, instances: rowEditorState(row).instances },
      row,
    );
    if (changesAnything(changes)) onChangeRow?.(changes);
  };

  const update = (
    next: RowEditorState | ((latest: RowEditorState) => RowEditorState),
  ) => {
    const prev = stateRef.current;
    const value = typeof next === "function" ? next(prev) : next;
    stateRef.current = value;
    setState(value);
    if (chosenResources(value) !== chosenResources(prev)) commit(value);
    else setDirty(true);
  };

  // Selecting another row in the grid swaps this editor out (it's keyed by
  // row) without a blur: the focused textarea is simply removed. So a draft
  // still pending then is committed on the way out, to the row it was made
  // on — `onChangeRow` is bound to that row.
  const commitPending = () => {
    if (dirty) commit(stateRef.current);
  };
  const commitOnEnter = (e: KeyboardEvent<HTMLDivElement>) => {
    // An editor that used Enter itself — to pick a suggestion, say — has
    // already claimed it.
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
  };
  const commitRef = useRef(commitPending);
  commitRef.current = commitPending;
  useEffect(() => () => commitRef.current(), []);

  const { instances } = state;
  const sectionSources = useMemo<PromptInputSources>(
    () => ({
      resources: withInstanceResources(catalog, instances),
      functionSlots: {},
      executeSlots: {},
      resourceSlots: Object.fromEntries(
        Object.entries(sources?.resourceSlots ?? {}).map(([uri, slots]) => [
          uri,
          withInstanceSlots(slots, catalog, instances),
        ]),
      ),
    }),
    [catalog, instances, sources],
  );

  const changeInstances = (
    next:
      | InstanceSelections
      | ((latest: InstanceSelections) => InstanceSelections),
    edit?: InstanceEdit,
  ) =>
    update(latest => {
      const value = typeof next === "function" ? next(latest.instances) : next;
      if (!edit) return { ...latest, instances: value };
      const [from, to] =
        edit.kind === "rename" ? [edit.from, edit.to] : [edit.name, null];
      return {
        instances: value,
        selections: retargetSelections(latest.selections, from, to),
      };
    });

  const context = instanceSourceContext({
    instances,
    catalogByUri,
    adopt: uri => {
      const picked = adoptCatalogPick(
        stateRef.current.instances,
        uri,
        catalogByUri,
      );
      // Left a draft: the pick that follows binds the new instance, and
      // saves both at once.
      const latest = stateRef.current;
      const next = { ...latest, instances: picked.instances };
      stateRef.current = next;
      setState(next);
      setDirty(true);
      return picked.uri;
    },
  });

  // Every field is one `DetailRow`; the section sits above them as one more.
  const editableRows = !!onChangeRow && !!sources;
  return (
    <>
      {fields.map(field => {
        const input = row.cells[field.id];
        return (
          <DetailRow
            key={field.id}
            label={
              <>
                <span className="dataset-detail-field">{field.def.name}</span>
                <span
                  className="dataset-detail-type"
                  title={field.def.type.syntax}
                >
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
                    if (
                      !e.currentTarget.contains(e.relatedTarget as Node | null)
                    ) {
                      commitPending();
                    }
                  }}
                  onKeyDown={commitOnEnter}
                >
                  <ExecutionInputEditor
                    propDef={field.def}
                    selection={state.selections[field.id] ?? {}}
                    onChange={selection =>
                      update(latest => ({
                        ...latest,
                        selections: {
                          ...latest.selections,
                          [field.id]: selection,
                        },
                      }))
                    }
                    resources={sectionSources.resources}
                    slots={withInstanceSlots(
                      sources?.fieldSlots[field.id],
                      catalog,
                      instances,
                    )}
                    context={sources && context}
                  />
                </div>
              ) : input ? (
                <InputView input={input} />
              ) : (
                <span className="dataset-cell-empty">—</span>
              )}
              {onChangeRow && input && (
                <button
                  type="button"
                  className="dataset-detail-clear"
                  title={`Clear ${field.def.name}`}
                  aria-label={`Clear ${field.def.name}`}
                  onClick={() => onChangeRow({ cells: { [field.id]: null } })}
                >
                  ×
                </button>
              )}
            </div>
          </DetailRow>
        );
      })}
      {editableRows ? (
        <DetailRow label={<span className="dataset-detail-field"></span>}>
          <div
            className="dataset-detail-editor"
            onBlur={(e: FocusEvent<HTMLDivElement>) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                commitPending();
              }
            }}
            onKeyDown={commitOnEnter}
          >
            <ResourcesSection
              instances={instances}
              onChange={changeInstances}
              sources={sectionSources}
              catalog={catalog}
              referencedBy={name =>
                referencesTo(name, instances, [
                  {
                    selections: Object.fromEntries(
                      fields.flatMap(f =>
                        state.selections[f.id]
                          ? [[f.def.name, state.selections[f.id]!] as const]
                          : [],
                      ),
                    ),
                  },
                ])
              }
              context={context}
            />
          </div>
        </DetailRow>
      ) : (
        <RowResources row={row} />
      )}
    </>
  );
}

/**
 * One dataset row in the details pane: when it was added and where from,
 * then every field — the same facts-over-blocks layout as a span's details.
 *
 * With `onChangeRow`, every field is edited in place as the execute panel
 * edits a parameter, and any cell can be cleared. The row's resource
 * instances are edited above the fields, from the catalog in `sources` — the
 * linked prompt's, since a dataset has none of its own. Without it, the
 * instances and any instance or `object` cell stay read-only. See
 * `specs/datasets.md` §P.2.
 */
export function DatasetRowDetails({
  dataset,
  row,
  onOpenTrace,
  onChangeRow,
  sources,
}: {
  dataset: Dataset;
  row: DatasetRow;
  onOpenTrace: (providerId: string, traceId: string) => void;
  /**
   * Sets fields' cells, by field id, or clears them with `null`, and sets or
   * removes the row's resource instances by name. Read-only without.
   */
  onChangeRow?: (update: Omit<DatasetRowUpdate, "rowId">) => void;
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
          onChangeRow={onChangeRow}
        />
      </div>
    </div>
  );
}
