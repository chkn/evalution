// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { Annotation, AnnotationKind, Span } from "../../../shared/types";
import { AnnotationChip } from "./AnnotationChip.tsx";
import {
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokenCount,
} from "./format.ts";
import {
  CalendarIcon,
  CostIcon,
  FlagIcon,
  ModelIcon,
  ProviderIcon,
  StopReasonIcon,
  StopwatchIcon,
  TokensIcon,
} from "./icons.tsx";
import { JsonView } from "./JsonView.tsx";
import { AnnotationForm } from "./TraceAnnotations.tsx";

export interface SpanDetailsProps {
  span: Span;
  annotations: Annotation[];
  freshIds: Set<string>;
  onClearFresh: (id: string) => void;
  onCreateAnnotation: (input: {
    kind: AnnotationKind;
    note: string;
    spanId: string;
  }) => Promise<void>;
  onDeleteAnnotation: (id: string) => Promise<void>;
}

export function SpanDetails({
  span,
  annotations,
  freshIds,
  onClearFresh,
  onCreateAnnotation,
  onDeleteAnnotation,
}: SpanDetailsProps) {
  const { llm, tool } = span;

  // Two groups of quiet icon + label + value facts: timing and stop reason,
  // then who ran it. Icons are the trace header's, where it has one.
  const dash = "—";
  const timing: Fact[] = [
    {
      label: "Started",
      icon: <CalendarIcon />,
      value: formatTimestamp(span.startTime),
    },
    {
      label: "Ended",
      icon: <FlagIcon />,
      value: span.endTime !== undefined ? formatTimestamp(span.endTime) : dash,
    },
    {
      label: "Duration",
      icon: <StopwatchIcon />,
      value:
        span.endTime !== undefined
          ? formatDuration(span.endTime - span.startTime)
          : dash,
    },
  ];
  if (llm?.finishReason) {
    timing.push({
      label: "Stop reason",
      icon: <StopReasonIcon />,
      value: llm.finishReason,
    });
  }

  const provenance: Fact[] = [];
  if (llm?.provider) {
    provenance.push({
      label: "Provider",
      icon: <ProviderIcon />,
      value: llm.provider,
    });
  }
  if (llm?.model) {
    provenance.push({ label: "Model", icon: <ModelIcon />, value: llm.model });
  }
  if (llm?.promptTokens !== undefined || llm?.completionTokens !== undefined) {
    provenance.push({
      label: "Tokens",
      icon: <TokensIcon />,
      value: `${formatTokenCount(llm.promptTokens ?? 0)} in · ${formatTokenCount(llm.completionTokens ?? 0)} out`,
    });
  }
  if (llm?.cost !== undefined) {
    const { prompt, completion } = llm.cost;
    provenance.push({
      label: "Cost",
      icon: <CostIcon />,
      value: `${formatCost(prompt + completion)} (${formatCost(prompt)} in · ${formatCost(completion)} out)`,
    });
  }

  const rows: Row[] = [];
  // A tool's arguments sit inside the first group, ahead of any error, so
  // what was asked reads before what went wrong.
  let argumentsRow: Row | undefined;
  if (llm?.modelParameters) {
    rows.push({
      label: "Model Parameters",
      value: <JsonView data={llm.modelParameters} />,
    });
  }
  if (tool?.toolName) {
    if (tool.input !== undefined) {
      argumentsRow = {
        label: "Arguments",
        value: <JsonView data={tool.input} />,
      };
    }
    if (tool.output !== undefined) {
      rows.push({
        label: "Result",
        value: <JsonView data={tool.output} />,
      });
    }
  }
  if (span.attributes) {
    rows.push({
      label: "Attributes",
      value: <JsonView data={span.attributes} />,
    });
  }

  const spanAnnotations = annotations.filter(a => a.spanId === span.id);

  return (
    <div className="span-details">
      <div className="span-details-list">
        <div className="span-details-facts">
          {timing.map(f => (
            <FactLine key={f.label} fact={f} />
          ))}
          {argumentsRow && (
            <DetailRow
              row={argumentsRow}
              className="span-details-row-in-group"
            />
          )}
          {span.errorMessage && (
            <pre className="span-details-error">{span.errorMessage}</pre>
          )}
        </div>
        {provenance.length > 0 && (
          <div className="span-details-facts">
            {provenance.map(f => (
              <FactLine key={f.label} fact={f} />
            ))}
          </div>
        )}

        {rows.map(r => (
          <DetailRow key={r.label} row={r} />
        ))}
      </div>

      <div className="span-details-section">
        <div className="span-details-section-title">Annotations</div>
        {spanAnnotations.length > 0 && (
          <div className="span-annotations-list">
            {spanAnnotations.map(a => (
              <span key={a.id} className="span-annotation-row">
                <AnnotationChip
                  annotation={a}
                  arriving={freshIds.has(a.id)}
                  onArrivalEnd={() => onClearFresh(a.id)}
                  showLabel
                />
                {a.note && (
                  <span className="span-annotation-note">{a.note}</span>
                )}
                <button
                  type="button"
                  className="annotation-card-delete"
                  onClick={() => onDeleteAnnotation(a.id)}
                  title="Delete annotation"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <SpanAnnotateButton
          onCreate={input => onCreateAnnotation({ ...input, spanId: span.id })}
        />
      </div>
    </div>
  );
}

/** One icon + label + value line in the span details facts. */
interface Fact {
  label: string;
  icon: React.ReactNode;
  value: string;
}

function FactLine({ fact }: { fact: Fact }) {
  return (
    <div className="span-details-fact" role="group" aria-label={fact.label}>
      <span className="span-details-fact-icon">{fact.icon}</span>
      <span className="span-details-fact-label">{fact.label}</span>
      <span className="span-details-fact-value">{fact.value}</span>
    </div>
  );
}

/** A labelled block — a heading over a JSON tree or other wide content. */
interface Row {
  label: string;
  value: React.ReactNode;
}

function DetailRow({ row, className }: { row: Row; className?: string }) {
  return (
    <div className={`span-details-row${className ? ` ${className}` : ""}`}>
      <div className="span-details-row-label">{row.label}</div>
      <div className="span-details-row-value">{row.value}</div>
    </div>
  );
}

function SpanAnnotateButton({
  onCreate,
}: {
  onCreate: (input: { kind: AnnotationKind; note: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <AnnotationForm
        submitLabel="Add annotation"
        onCancel={() => setOpen(false)}
        onSubmit={async input => {
          await onCreate(input);
          setOpen(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="trace-annotations-add"
      onClick={() => setOpen(true)}
    >
      + Annotate span
    </button>
  );
}
