// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useRef, useState } from "react";
import type { Annotation, AnnotationKind } from "../../../shared/types";
import {
  ANNOTATION_ARRIVAL_MS,
  AnnotationChip,
  annotationSourceLabel,
  KIND_STYLES,
} from "./AnnotationChip.tsx";

const KINDS: AnnotationKind[] = ["issue", "good", "note"];

function timeAgo(ts: number): string {
  const delta = (Date.now() - ts) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function AnnotationCard({
  annotation,
  arriving,
  onArrivalEnd,
  onDelete,
}: {
  annotation: Annotation;
  arriving: boolean;
  onArrivalEnd: () => void;
  onDelete: () => void;
}) {
  const endRef = useRef(onArrivalEnd);
  endRef.current = onArrivalEnd;

  useEffect(() => {
    if (!arriving) return;
    const handle = window.setTimeout(
      () => endRef.current(),
      ANNOTATION_ARRIVAL_MS,
    );
    return () => window.clearTimeout(handle);
  }, [arriving]);

  return (
    <div
      className={`annotation-card annotation-card-${annotation.kind}${
        arriving ? ` annotation-arriving kind-${annotation.kind}` : ""
      }`}
    >
      <div className="annotation-card-body">
        <div className="annotation-card-header">
          <AnnotationChip annotation={annotation} showLabel />
          <span className="annotation-card-meta">
            {annotationSourceLabel(annotation.source)} ·{" "}
            {timeAgo(annotation.createdAt)}
          </span>
        </div>
        {annotation.note && (
          <div className="annotation-card-note">{annotation.note}</div>
        )}
      </div>
      <button
        type="button"
        className="annotation-card-delete"
        onClick={onDelete}
        title="Delete annotation"
      >
        ×
      </button>
    </div>
  );
}

/** Inline kind-picker + note textarea, shared by the trace- and span-level "add annotation" flows. */
export function AnnotationForm({
  initialKind = "note",
  submitLabel = "Save",
  onCancel,
  onSubmit,
}: {
  initialKind?: AnnotationKind;
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (input: {
    kind: AnnotationKind;
    note: string;
  }) => void | Promise<void>;
}) {
  const [kind, setKind] = useState<AnnotationKind>(initialKind);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // The server rejects an empty note with a 400, so don't let one be sent —
  // a rejected `createAnnotation` would surface as nothing but a dead button.
  const canSave = note.trim().length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSubmit({ kind, note: note.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="annotation-form">
      <div className="annotation-form-kinds">
        {KINDS.map(k => {
          const style = KIND_STYLES[k];
          return (
            <button
              key={k}
              type="button"
              className={`annotation-form-kind-btn annotation-chip-${k}${k === kind ? " annotation-form-kind-selected" : ""}`}
              onClick={() => setKind(k)}
            >
              <span className="annotation-chip-icon">{style.icon}</span>
              {style.label}
            </button>
          );
        })}
      </div>
      <textarea
        autoFocus
        className="annotation-form-note"
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="What did you notice?"
        onKeyDown={e => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="annotation-form-actions">
        <button
          type="button"
          className="annotation-form-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="annotation-form-submit"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

interface TraceAnnotationsProps {
  annotations: Annotation[];
  freshIds: Set<string>;
  onClearFresh: (id: string) => void;
  onCreate: (input: { kind: AnnotationKind; note: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** Whether the "add annotation" form is open; its trigger button lives in the trace header. */
  showForm: boolean;
  onCloseForm: () => void;
}

/** Trace-level annotation cards + the "add annotation" form (opened via a header button). */
export function TraceAnnotations({
  annotations,
  freshIds,
  onClearFresh,
  onCreate,
  onDelete,
  showForm,
  onCloseForm,
}: TraceAnnotationsProps) {
  const traceAnnotations = annotations.filter(a => a.spanId === undefined);

  if (traceAnnotations.length === 0 && !showForm) return null;

  return (
    <div className="trace-annotations">
      {traceAnnotations.length > 0 && (
        <div className="trace-annotations-list">
          {traceAnnotations.map(a => (
            <AnnotationCard
              key={a.id}
              annotation={a}
              arriving={freshIds.has(a.id)}
              onArrivalEnd={() => onClearFresh(a.id)}
              onDelete={() => onDelete(a.id)}
            />
          ))}
        </div>
      )}
      {showForm && (
        <AnnotationForm
          submitLabel="Add annotation"
          onCancel={onCloseForm}
          onSubmit={async input => {
            await onCreate(input);
            onCloseForm();
          }}
        />
      )}
    </div>
  );
}
