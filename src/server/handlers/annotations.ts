// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { AnnotationKind, AnnotationSource } from "../../shared/types.ts";
import type { TraceProvider } from "../../trace/trace-provider.ts";

export interface AnnotationHandlerResult {
  status: number;
  body: unknown;
}

const UNSUPPORTED: AnnotationHandlerResult = {
  status: 405,
  body: { error: "This trace provider does not support annotations" },
};

/** `GET /api/traces/:providerId/:traceId/annotations` */
export async function handleListAnnotations(
  provider: TraceProvider,
  traceId: string,
): Promise<AnnotationHandlerResult> {
  if (!provider.listAnnotations) return UNSUPPORTED;
  return { status: 200, body: await provider.listAnnotations(traceId) };
}

export interface CreateAnnotationBody {
  spanId?: string;
  kind: AnnotationKind;
  note: string;
  /**
   * Who this annotation is from. The UI inserts `'user'` by default; an
   * external caller (a coding agent replaying a trace) sets `'claude-code'`
   * or `'codex'` explicitly to trigger the arrival animation §0f gives
   * agent-sourced annotations. Defaults to `'user'` when omitted.
   */
  source?: AnnotationSource;
}

/** `POST /api/traces/:providerId/:traceId/annotations` */
export async function handleCreateAnnotation(
  provider: TraceProvider,
  traceId: string,
  body: CreateAnnotationBody,
): Promise<AnnotationHandlerResult> {
  if (!provider.createAnnotation) return UNSUPPORTED;
  if (!body?.kind || !body?.note) {
    return { status: 400, body: { error: "kind and note are required" } };
  }

  const annotation = await provider.createAnnotation({
    traceId,
    kind: body.kind,
    note: body.note,
    source: body.source ?? "user",
    ...(body.spanId && { spanId: body.spanId }),
  });
  provider.emitAnnotation?.(traceId, "insert", annotation);
  return { status: 201, body: annotation };
}

/** `DELETE /api/traces/:providerId/:traceId/annotations/:id` */
export async function handleDeleteAnnotation(
  provider: TraceProvider,
  traceId: string,
  id: string,
): Promise<AnnotationHandlerResult> {
  if (!provider.deleteAnnotation || !provider.listAnnotations)
    return UNSUPPORTED;

  // The provider only offers a scoped `listAnnotations(traceId)`, not a
  // global "get by id" — look it up there first, both to 404 correctly and
  // because `emitAnnotation` needs the full annotation, not just its id.
  const existing = (await provider.listAnnotations(traceId)).find(
    a => a.id === id,
  );
  if (!existing)
    return { status: 404, body: { error: "Annotation not found" } };

  await provider.deleteAnnotation(id);
  provider.emitAnnotation?.(traceId, "delete", existing);
  return { status: 204, body: undefined };
}
