// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { Annotation, AnnotationKind, Span } from "../../../shared/types";
import { AnnotationChip } from "./AnnotationChip.tsx";
import { formatCost } from "./format.ts";
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
  const rows: { label: string; value: React.ReactNode }[] = [];

  rows.push({ label: "ID", value: <code>{span.id}</code> });
  if (span.status) rows.push({ label: "Status", value: span.status });
  if (span.errorMessage) {
    rows.push({
      label: "Error",
      value: <pre className="span-details-error">{span.errorMessage}</pre>,
    });
  }

  if (llm?.provider || llm?.model) {
    if (llm.provider) rows.push({ label: "Provider", value: llm.provider });
    if (llm.model) rows.push({ label: "Model", value: llm.model });
    if (llm.promptTokens !== undefined || llm.completionTokens !== undefined) {
      rows.push({
        label: "Tokens",
        value: `${llm.promptTokens ?? 0} in · ${llm.completionTokens ?? 0} out · ${
          llm.totalTokens ??
          (llm.promptTokens ?? 0) + (llm.completionTokens ?? 0)
        } total`,
      });
    }
    if (llm.cost !== undefined) {
      const total = llm.cost.prompt + llm.cost.completion;
      rows.push({
        label: "Cost",
        value: `${formatCost(total)} (${formatCost(llm.cost.prompt)} in · ${formatCost(llm.cost.completion)} out)`,
      });
    }
    if (llm.modelParameters) {
      rows.push({
        label: "Model Parameters",
        value: <JsonView data={llm.modelParameters} />,
      });
    }
  }

  if (tool?.toolName) {
    if (tool.input !== undefined) {
      rows.push({
        label: "Arguments",
        value: <JsonView data={tool.input} />,
      });
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
        {rows.map((r, i) => (
          <div key={i} className="span-details-row">
            <div className="span-details-row-label">{r.label}</div>
            <div className="span-details-row-value">{r.value}</div>
          </div>
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
