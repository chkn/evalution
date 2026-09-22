// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { Annotation, AnnotationKind, Span } from "../../../shared/types";
import { DetailRow, type Fact, FactGroup, FactsGrid } from "../DetailsPane.tsx";
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
    const prompt = llm.promptTokens ?? 0;
    const completion = llm.completionTokens ?? 0;
    provenance.push({
      label: "Tokens",
      icon: <TokensIcon />,
      value: `${formatTokenCount(prompt)} in · ${formatTokenCount(completion)} out · ${formatTokenCount(llm.totalTokens ?? prompt + completion)} total`,
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

  const rows: { label: string; value: React.ReactNode }[] = [];
  // A tool's arguments sit inside the first group, ahead of any error, so
  // what was asked reads before what went wrong.
  let argumentsValue: React.ReactNode | undefined;
  if (llm?.modelParameters) {
    rows.push({
      label: "Model Parameters",
      value: <JsonView data={llm.modelParameters} />,
    });
  }
  if (tool?.toolName) {
    if (tool.input !== undefined) {
      argumentsValue = <JsonView data={tool.input} />;
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
        <FactsGrid>
          <FactGroup facts={timing}>
            {argumentsValue && (
              <DetailRow
                label="Arguments"
                className="span-details-row-in-group"
              >
                {argumentsValue}
              </DetailRow>
            )}
            {span.errorMessage && (
              <pre className="span-details-error">{span.errorMessage}</pre>
            )}
          </FactGroup>
          {provenance.length > 0 && <FactGroup facts={provenance} />}
        </FactsGrid>

        {rows.map(r => (
          <DetailRow key={r.label} label={r.label}>
            {r.value}
          </DetailRow>
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
