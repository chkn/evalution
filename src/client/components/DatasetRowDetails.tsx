// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { ItemEditor, shortSyntax } from "ts-proppy/react";
import { committedCell } from "../../shared/dataset-cells";
import type {
  Dataset,
  DatasetRow,
  ExecutionInput,
  PropDefinition,
  PropValue,
} from "../../shared/types";
import { DetailRow, type Fact, FactGroup, FactsGrid } from "./DetailsPane";
import { previewCell, propValueToJson, resourceName } from "./dataset-preview";
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
      return <code className="dataset-detail-scalar">{previewCell(input)}</code>;
  }
}

/**
 * A field's value in `ItemEditor`, against the field's `def` as the execute
 * panel edits a parameter. Edits stay a local draft and are committed on
 * blur, on Enter (Shift+Enter still types a newline), or when the editor
 * goes away, rather than on every keystroke — each commit is a save.
 */
function CellEditor({
  def,
  value,
  onCommit,
}: {
  def: PropDefinition;
  value: PropValue | undefined;
  onCommit: (cell: ExecutionInput | null) => void;
}) {
  const [draft, setDraft] = useState<PropValue | undefined>(value);
  const [dirty, setDirty] = useState(false);
  // A new stored value — the refetch after a save — replaces a clean draft.
  const [stored, setStored] = useState(value);
  if (stored !== value) {
    setStored(value);
    if (!dirty) setDraft(value);
  }

  const commit = () => {
    if (!dirty || draft === undefined) return;
    setDirty(false);
    if (JSON.stringify(draft) === JSON.stringify(value)) return;
    onCommit(committedCell(draft));
  };

  // Selecting another row in the grid swaps this editor out (it's keyed by
  // row) without a blur: the focused textarea is simply removed. So a draft
  // still pending then is committed on the way out, to the row it was made
  // on — `onCommit` is bound to that row.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);

  return (
    <div
      className="dataset-detail-editor"
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        // An editor that used Enter itself — to pick a suggestion, say —
        // has already claimed it.
        if (
          e.key !== "Enter" ||
          e.shiftKey ||
          e.defaultPrevented ||
          e.nativeEvent.isComposing
        ) {
          return;
        }
        e.preventDefault();
        commit();
      }}
    >
      <ItemEditor
        propDef={def}
        value={draft}
        onChange={next => {
          setDraft(next);
          setDirty(true);
        }}
        path={[def.name]}
      />
    </div>
  );
}

/**
 * One dataset row in the details pane: when it was added and where from,
 * then every field — the same facts-over-blocks layout as a span's details.
 *
 * With `onChangeCell`, a field that's empty or holds a typed-in value is
 * edited in place, and any cell can be cleared. An `object` or `resource`
 * cell stays read-only: editing one means offering resources, which needs a
 * prompt's `inputSources`, and a dataset has none. See `specs/datasets.md`
 * §P.2.
 */
export function DatasetRowDetails({
  dataset,
  row,
  onOpenTrace,
  onChangeCell,
}: {
  dataset: Dataset;
  row: DatasetRow;
  onOpenTrace: (providerId: string, traceId: string) => void;
  /** Sets a field's cell, or clears it with `null`. Read-only without. */
  onChangeCell?: (fieldId: string, cell: ExecutionInput | null) => void;
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
        {dataset.fields.map(field => {
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
                {onChangeCell && (!input || input.kind === "value") ? (
                  <CellEditor
                    // Per row, so a draft never carries over to the next one.
                    key={row.id}
                    def={field.def}
                    value={input?.value}
                    onCommit={cell => onChangeCell(field.id, cell)}
                  />
                ) : input ? (
                  <InputView input={input} />
                ) : (
                  <span className="dataset-cell-empty">—</span>
                )}
                {onChangeCell && input && (
                  <button
                    type="button"
                    className="dataset-detail-clear"
                    title={`Clear ${field.def.name}`}
                    aria-label={`Clear ${field.def.name}`}
                    onClick={() => onChangeCell(field.id, null)}
                  >
                    ×
                  </button>
                )}
              </div>
            </DetailRow>
          );
        })}
      </div>
    </div>
  );
}
