// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Loads annotations for a trace and keeps them live via the same per-trace
 * SSE connection `TraceView` already holds open — the caller forwards
 * `{type: 'annotation', …}` events from its `subscribeTraceEvents` callback
 * into {@link UseAnnotationsResult.applyEvent}, rather than this hook opening
 * a second connection.
 *
 * `freshIds` is the set of annotation ids that arrived as a genuinely live
 * insert (after this hook's initial load, i.e. not part of the
 * replay-on-connect batch) from a non-`user` source — the caller uses this to
 * trigger the arrival animation exactly once per annotation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Annotation,
  AnnotationKind,
  TraceLiveEvent,
} from "../../shared/types";
import { createAnnotation, deleteAnnotation, getAnnotations } from "../api";

function sortByCreatedAt(annotations: Annotation[]): Annotation[] {
  return [...annotations].sort((a, b) => a.createdAt - b.createdAt);
}

export interface UseAnnotationsResult {
  annotations: Annotation[];
  freshIds: Set<string>;
  clearFresh: (id: string) => void;
  create: (input: {
    kind: AnnotationKind;
    note: string;
    spanId?: string;
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Feed a `TraceLiveEvent` from the trace's SSE subscription here; non-annotation events are ignored. */
  applyEvent: (event: TraceLiveEvent) => void;
}

export function useAnnotations(
  providerId: string,
  traceId: string | null | undefined,
): UseAnnotationsResult {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  const hydrated = useRef(false);

  useEffect(() => {
    hydrated.current = false;
    setAnnotations([]);
    setFreshIds(new Set());
    if (!traceId) return;

    let cancelled = false;
    getAnnotations(providerId, traceId)
      .then(list => {
        if (cancelled) return;
        setAnnotations(sortByCreatedAt(list));
      })
      .finally(() => {
        if (!cancelled) hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, traceId]);

  const applyEvent = useCallback((event: TraceLiveEvent) => {
    if (event.type !== "annotation") return;
    const { op, annotation } = event;
    if (op === "insert") {
      setAnnotations(prev =>
        prev.some(a => a.id === annotation.id)
          ? prev
          : sortByCreatedAt([...prev, annotation]),
      );
      // Only agent annotations animate — user-authored ones appear silently
      // because the user just created them and doesn't need a CTA. Replayed
      // (pre-existing) annotations from before this hook hydrated don't
      // animate either.
      if (hydrated.current && annotation.source !== "user") {
        setFreshIds(prev => new Set(prev).add(annotation.id));
      }
    } else {
      setAnnotations(prev => prev.filter(a => a.id !== annotation.id));
      setFreshIds(prev => {
        if (!prev.has(annotation.id)) return prev;
        const next = new Set(prev);
        next.delete(annotation.id);
        return next;
      });
    }
  }, []);

  const clearFresh = useCallback((id: string) => {
    setFreshIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const create = useCallback(
    async (input: { kind: AnnotationKind; note: string; spanId?: string }) => {
      if (!traceId) return;
      const annotation = await createAnnotation(providerId, traceId, input);
      setAnnotations(prev =>
        prev.some(a => a.id === annotation.id)
          ? prev
          : sortByCreatedAt([...prev, annotation]),
      );
    },
    [providerId, traceId],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!traceId) return;
      await deleteAnnotation(providerId, traceId, id);
      setAnnotations(prev => prev.filter(a => a.id !== id));
    },
    [providerId, traceId],
  );

  return { annotations, freshIds, clearFresh, create, remove, applyEvent };
}
