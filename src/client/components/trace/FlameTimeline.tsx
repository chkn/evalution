// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The trace waterfall: a flame-graph-style timeline merged with the span
 * tree (each row is both a timing bar and a tree node with depth indentation
 * + disclosure toggle)
 */

import { useState } from "react";
import type {
  Annotation,
  AnnotationKind,
  PromptID,
} from "../../../shared/types";
import { AnnotationChip } from "./AnnotationChip.tsx";
import { formatDuration } from "./format.ts";
import { PromptLinkIcon } from "./icons.tsx";
import { JsonView } from "./JsonView.tsx";
import { MessageList } from "./MessageList.tsx";
import type { Row } from "./rows.ts";
import type { SpanViewModel } from "./spanViewModel.ts";
import { AnnotationForm } from "./TraceAnnotations.tsx";

function SpanKindPill({ kind }: { kind: SpanViewModel["spanType"] }) {
  return <span className={`span-kind-pill span-kind-${kind}`}>{kind}</span>;
}

function SpanErrorIcon({ visible }: { visible: boolean }) {
  return (
    <svg
      className="span-error-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-label={visible ? "Error" : undefined}
      aria-hidden={!visible}
      style={{ visibility: visible ? "visible" : "hidden" }}
    >
      <path
        d="M7.06 2.8 1.8 12.2A1 1 0 0 0 2.7 13.7h10.6a1 1 0 0 0 .9-1.5L9.0 2.8a1.15 1.15 0 0 0-1.94 0Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.5v3M8 11v.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`trace-disclosure-icon${expanded ? " trace-disclosure-icon-open" : ""}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
    >
      <path
        d="M2.5 3.5 5 6.5l2.5-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface SpanDetailsProps {
  span: SpanViewModel;
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

function SpanDetails({
  span,
  annotations,
  freshIds,
  onClearFresh,
  onCreateAnnotation,
  onDeleteAnnotation,
}: SpanDetailsProps) {
  const rows: { label: string; value: React.ReactNode }[] = [];

  rows.push({ label: "ID", value: <code>{span.id}</code> });
  rows.push({ label: "Kind", value: span.spanType });
  if (span.status) rows.push({ label: "Status", value: span.status });
  if (span.errorMessage) {
    rows.push({
      label: "Error",
      value: <pre className="span-details-error">{span.errorMessage}</pre>,
    });
  }

  if (span.provider || span.model) {
    if (span.provider) rows.push({ label: "Provider", value: span.provider });
    if (span.model) rows.push({ label: "Model", value: span.model });
    if (
      span.promptTokens !== undefined ||
      span.completionTokens !== undefined
    ) {
      rows.push({
        label: "Tokens",
        value: `${span.promptTokens ?? 0} in · ${span.completionTokens ?? 0} out · ${
          span.totalTokens ??
          (span.promptTokens ?? 0) + (span.completionTokens ?? 0)
        } total`,
      });
    }
    if (span.cost !== undefined) {
      rows.push({ label: "Cost", value: `$${span.cost.toFixed(5)}` });
    }
    if (span.modelParameters) {
      rows.push({
        label: "Model Parameters",
        value: <JsonView data={span.modelParameters} />,
      });
    }
  }

  if (span.toolName) {
    rows.push({ label: "Tool", value: span.toolName });
    if (span.toolArgs !== undefined) {
      rows.push({
        label: "Arguments",
        value: <JsonView data={span.toolArgs} />,
      });
    }
    if (span.toolResult !== undefined) {
      rows.push({
        label: "Result",
        value: <JsonView data={span.toolResult} />,
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
      <dl className="span-details-list">
        {rows.map((r, i) => (
          <div key={i} className="span-details-row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>

      {span.messages && span.messages.length > 0 && (
        <div className="span-details-section">
          <div className="span-details-section-title">Input</div>
          <MessageList messages={span.messages} />
        </div>
      )}

      {span.output && (
        <div className="span-details-section">
          <div className="span-details-section-title">Output</div>
          <MessageList
            messages={[{ role: "assistant", content: span.output }]}
          />
        </div>
      )}

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

export interface FlameTimelineProps {
  rows: Row[];
  window: { start: number; end: number };
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string | null) => void;
  onOpenPrompt?: (prompt: PromptID) => void;
  /** Span whose row-level "Open prompt" button is shown elsewhere (e.g. hoisted into a header), so it should be suppressed here. */
  hidePromptButtonSpanId?: string;
  annotations: Annotation[];
  freshAnnotationIds: Set<string>;
  onClearFreshAnnotation: (id: string) => void;
  onCreateAnnotation: (input: {
    kind: AnnotationKind;
    note: string;
    spanId: string;
  }) => Promise<void>;
  onDeleteAnnotation: (id: string) => Promise<void>;
}

export function FlameTimeline({
  rows,
  window,
  selectedSpanId,
  onSelectSpan,
  onOpenPrompt,
  hidePromptButtonSpanId,
  annotations,
  freshAnnotationIds,
  onClearFreshAnnotation,
  onCreateAnnotation,
  onDeleteAnnotation,
}: FlameTimelineProps) {
  const totalDuration = Math.max(1, window.end - window.start);

  return (
    <div className="trace-waterfall">
      {rows.map(row => {
        const span = row.span;
        const relStart = span.startMs - window.start;
        const spanEnd = span.endMs ?? window.end;
        const relEnd = spanEnd - window.start;
        const leftPct = (relStart / totalDuration) * 100;
        const widthPct = Math.max(
          0.5,
          ((relEnd - relStart) / totalDuration) * 100,
        );
        const isSelected = span.id === selectedSpanId;
        const running = span.endMs === undefined;
        const duration = running ? undefined : spanEnd - span.startMs;

        const hasError = span.status === "error";
        const spanAnnotationCount = annotations.filter(
          a => a.spanId === span.id,
        ).length;
        // Only resolved prompts (provider-scoped) can be opened; an unresolved
        // global id wouldn't match any prompt in the list.
        const canOpenPrompt = !!(
          span.promptId &&
          span.promptProviderId &&
          onOpenPrompt
        );
        const handleOpenPrompt = canOpenPrompt
          ? () =>
              onOpenPrompt!({
                id: span.promptId!,
                providerId: span.promptProviderId,
              })
          : undefined;

        return (
          <div
            key={span.id}
            className={`trace-row${isSelected ? " trace-row-expanded" : ""}${hasError ? " trace-row-error" : ""}`}
          >
            <div className="trace-row-main">
              <div
                className="trace-row-label"
                style={{ paddingLeft: row.depth * 16 }}
              >
                <button
                  type="button"
                  className="trace-row-disclosure"
                  onClick={() => onSelectSpan(isSelected ? null : span.id)}
                  aria-label={isSelected ? "Collapse" : "Expand"}
                >
                  <DisclosureChevron expanded={isSelected} />
                </button>
                <SpanErrorIcon visible={hasError} />
                {span.spanType !== "DEFAULT" && (
                  <SpanKindPill kind={span.spanType} />
                )}
                <span
                  className={`trace-row-name${canOpenPrompt ? " trace-row-name-linked" : ""}`}
                  onClick={handleOpenPrompt}
                >
                  {span.name}
                </span>
                {spanAnnotationCount > 0 && (
                  <span
                    className="trace-row-annotation-count"
                    title={`${spanAnnotationCount} annotation(s)`}
                  >
                    {spanAnnotationCount}
                  </span>
                )}
                {canOpenPrompt && span.id !== hidePromptButtonSpanId && (
                  <button
                    type="button"
                    className="trace-row-prompt-btn"
                    onClick={handleOpenPrompt}
                    title="Open prompt"
                  >
                    <PromptLinkIcon />
                  </button>
                )}
              </div>
              <div className="trace-row-duration">
                {duration !== undefined
                  ? formatDuration(duration)
                  : running
                    ? "…"
                    : ""}
              </div>
              <div className="trace-row-bar-track">
                <div
                  className={`trace-row-bar trace-row-bar-${span.spanType}${running ? " trace-row-bar-running" : ""}`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
              </div>
            </div>
            {isSelected && (
              <div className="trace-row-details">
                <SpanDetails
                  span={span}
                  annotations={annotations}
                  freshIds={freshAnnotationIds}
                  onClearFresh={onClearFreshAnnotation}
                  onCreateAnnotation={onCreateAnnotation}
                  onDeleteAnnotation={onDeleteAnnotation}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
