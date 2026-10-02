// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  AnnotationChanges,
  AnnotationKind,
  AnnotationSource,
} from "../../shared/types.ts";
import type { TraceProvider } from "../../trace/trace-provider.ts";
import { errorResult, type HandlerResult } from "./result.ts";

/** What an annotation handler returns; the route relays it. */
export type AnnotationHandlerResult = HandlerResult;

const ANNOTATION_KINDS: readonly AnnotationKind[] = ["issue", "good", "note"];
const ANNOTATION_SOURCES: readonly AnnotationSource[] = [
  "user",
  "claude-code",
  "codex",
  "agent",
];

const UNSUPPORTED = errorResult(
  405,
  "This trace provider does not support annotations",
);

/** The 400 for a `kind` that isn't one, or `undefined` when it is. */
function invalidKind(kind: unknown): AnnotationHandlerResult | undefined {
  return ANNOTATION_KINDS.includes(kind as AnnotationKind)
    ? undefined
    : errorResult(400, `kind must be one of ${ANNOTATION_KINDS.join(", ")}`);
}

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
   * external caller (a coding agent replaying a trace) sets `'claude-code'`,
   * `'codex'`, or `'agent'` explicitly to trigger the arrival animation §0f gives
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
  const badKind = invalidKind(body.kind);
  if (badKind) return badKind;
  if (body.source !== undefined && !ANNOTATION_SOURCES.includes(body.source)) {
    return {
      status: 400,
      body: { error: `source must be one of ${ANNOTATION_SOURCES.join(", ")}` },
    };
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

/** The body of `PATCH /api/traces/:providerId/:traceId/annotations/:id`. */
export interface UpdateAnnotationBody {
  kind?: AnnotationKind;
  note?: string;
}

/** `PATCH /api/traces/:providerId/:traceId/annotations/:id` */
export async function handleUpdateAnnotation(
  provider: TraceProvider,
  traceId: string,
  id: string,
  body: UpdateAnnotationBody,
): Promise<AnnotationHandlerResult> {
  if (!provider.updateAnnotation || !provider.listAnnotations)
    return UNSUPPORTED;
  const badKind = body?.kind === undefined ? undefined : invalidKind(body.kind);
  if (badKind) return badKind;
  if (
    body?.note !== undefined &&
    (typeof body.note !== "string" || !body.note)
  ) {
    return { status: 400, body: { error: "note must be a non-empty string" } };
  }
  const changes: AnnotationChanges = {
    ...(body?.kind !== undefined && { kind: body.kind }),
    ...(body?.note !== undefined && { note: body.note }),
  };

  // Scoped to `traceId`, as delete is: an id from another trace is a 404.
  const existing = (await provider.listAnnotations(traceId)).some(
    a => a.id === id,
  );
  const updated = existing && (await provider.updateAnnotation(id, changes));
  if (!updated) return { status: 404, body: { error: "Annotation not found" } };

  provider.emitAnnotation?.(traceId, "update", updated);
  return { status: 200, body: updated };
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
