// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { normalizeOtlpRequest } from "../../trace/otlp/normalize.ts";
import { decodeOtlpProtobuf } from "../../trace/otlp/otlp-protobuf.ts";
import type { OtlpTraceIngestor } from "../../trace/otlp-trace-ingestor.ts";

/**
 * Placeholder for cloud auth context. OSS has none; a cloud host's
 * `resolveIngestor` narrows this to whatever it derives from the request's
 * API key (project + environment). Kept as an extension point so
 * {@link OtlpIngestDeps} doesn't need to change shape when cloud adds it.
 */
export type AuthCtx = Record<string, unknown>;

export interface OtlpIngestDeps {
  /**
   * Picks which {@link OtlpTraceIngestor} a batch should be recorded through.
   * OSS resolves this to "the process's single ingestor" (optionally keying
   * off an `x-evalution-provider` header when more than one trace provider is
   * configured); a cloud host keys off `ctx.auth` instead. Returns `undefined`
   * when nothing matches, in which case the request is rejected — this
   * handler never guesses a target.
   */
  resolveIngestor(ctx: {
    headers: Record<string, string>;
    auth?: AuthCtx;
  }): OtlpTraceIngestor | undefined;
}

export interface OtlpIngestRequest {
  /** The request's `content-type` header, e.g. `application/x-protobuf`. */
  contentType: string;
  body: ArrayBuffer;
  headers: Record<string, string>;
  auth?: AuthCtx;
}

export interface OtlpIngestResult {
  status: number;
  body: unknown;
}

/**
 * Host-neutral handler for an OTLP trace export request (`POST /v1/traces`).
 * Decodes protobuf or JSON, normalizes to `NormalizedOtlpSpan[]`, and hands
 * the batch to whichever {@link OtlpTraceIngestor} {@link OtlpIngestDeps.resolveIngestor}
 * picks. Takes and returns plain data (`ArrayBuffer` + headers, `{status,
 * body}`) rather than a framework `Request`/`Response` so it stays usable
 * from Hono, a Worker, or a test — no `Buffer`, no `fs`, no `process`.
 */
export async function handleOtlpTraces(
  req: OtlpIngestRequest,
  deps: OtlpIngestDeps,
): Promise<OtlpIngestResult> {
  let normalized: ReturnType<typeof normalizeOtlpRequest>;
  try {
    const mediaType = req.contentType.split(";")[0]?.trim().toLowerCase();
    if (
      mediaType === "application/x-protobuf" ||
      mediaType === "application/protobuf"
    ) {
      const decoded = decodeOtlpProtobuf(new Uint8Array(req.body));
      normalized = normalizeOtlpRequest(decoded);
    } else if (mediaType === "application/json") {
      const text = new TextDecoder().decode(req.body);
      normalized = normalizeOtlpRequest(JSON.parse(text));
    } else {
      return {
        status: 415,
        body: { error: `Unsupported content-type: ${req.contentType}` },
      };
    }
  } catch (err: any) {
    return {
      status: 400,
      body: { error: `Malformed OTLP payload: ${err?.message ?? err}` },
    };
  }

  const ingestor = deps.resolveIngestor({
    headers: req.headers,
    auth: req.auth,
  });
  if (!ingestor) {
    return {
      status: 404,
      body: { error: "No trace ingestor available for this request" },
    };
  }

  await ingestor.ingest(normalized);
  // OTLP's success response: an empty `partialSuccess` means every span was
  // accepted. Nothing here rejects individual spans, so it's always empty.
  return { status: 200, body: { partialSuccess: {} } };
}
