// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { shortSyntax } from "ts-proppy/react";
import type {
  Dataset,
  DatasetRow,
  ExecutionInput,
  PropValue,
} from "../../shared/types";
import { DetailRow, type Fact, FactGroup, FactsGrid } from "./DetailsPane";
import { propValueToJson, resourceName } from "./dataset-preview";
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
      return <code className="dataset-detail-scalar">{input.uri}</code>;
  }
}

/**
 * One dataset row in the details pane: when it was added and where from,
 * then every field — the same facts-over-blocks layout as a span's details.
 */
export function DatasetRowDetails({
  dataset,
  row,
  onOpenTrace,
}: {
  dataset: Dataset;
  row: DatasetRow;
  onOpenTrace: (providerId: string, traceId: string) => void;
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
              {input ? (
                <InputView input={input} />
              ) : (
                <span className="dataset-cell-empty">—</span>
              )}
            </DetailRow>
          );
        })}
      </div>
    </div>
  );
}
