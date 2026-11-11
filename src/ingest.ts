// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Trace ingestion without a server: the handlers behind `POST /v1/traces`
 * (OTLP) and `POST /api/traces` (evalution's own events), the normalizers
 * they use, and the ingestors that turn what they decode into spans.
 *
 * Everything here is runtime-neutral: no `fs`, no `process`, no Node
 * built-ins, so it runs on Cloudflare Workers too, where Evalution Cloud
 * ingests production traces with it. `src/ingest.test.ts` checks that by
 * bundling it for a Worker.
 * @module evalution/ingest
 */

export {
  type AuthCtx,
  handleOtlpTraces,
  type OtlpIngestDeps,
  type OtlpIngestRequest,
  type OtlpIngestResult,
} from "./server/handlers/otlp-ingest.ts";
export {
  handleTraceEvents,
  type TraceEventsIngestResult,
} from "./server/handlers/trace-events-ingest.ts";
export {
  CostFetchingTraceSink,
  type CostFetchingTraceSinkOptions,
} from "./trace/cost-fetching-trace-sink.ts";
export {
  type NormalizedOtlpEvent,
  type NormalizedOtlpSpan,
  normalizeOtlpRequest,
} from "./trace/otlp/normalize.ts";
export { decodeOtlpProtobuf } from "./trace/otlp/otlp-protobuf.ts";
export { OtlpTraceIngestor } from "./trace/otlp-trace-ingestor.ts";
export { mergeSpans } from "./trace/span-merge.ts";
export { TraceEventIngestor } from "./trace/trace-event-ingestor.ts";
