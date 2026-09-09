// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
//
// Walks an OTLP `ExportTraceServiceRequest` — decoded from protobuf via
// `./otlp-protobuf.ts`, or `JSON.parse`d directly (OTLP/JSON uses the same
// camelCase field names) — into `NormalizedOtlpSpan`s. Adapted from the
// resourceSpans→scopeSpans→spans walk, hex-id, and status normalization in
// Workshop's `src/parse.ts`; see `specs/trace-workshopping.md` §A.2. Unlike
// Workshop's `ParsedSpan`, this stops at a thin, SDK-agnostic shape — mapping
// to an evalution `Span` is `../otlp-trace-ingestor.ts`'s job, via the shared
// `../otel-attributes.ts` rules.

/** A single event attached to a span (e.g. an exception record). */
export interface NormalizedOtlpEvent {
  name: string;
  timeMs: number;
  attributes: Record<string, unknown>;
}

/**
 * One span from an OTLP export batch, decoded and normalized enough that both
 * the protobuf and JSON encodings produce identical output: hex trace/span
 * ids, millisecond timestamps, a readable `statusCode`, and a plain
 * `attributes` bag (nested `kvlist`/`array` values converted to plain
 * objects/arrays).
 */
export interface NormalizedOtlpSpan {
  traceId: string;
  spanId: string;
  /** `undefined` for a root span. */
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  /** `undefined` for a span OTLP exported without an end time. */
  endTimeMs?: number;
  statusCode: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Record<string, unknown>;
  events?: NormalizedOtlpEvent[];
}

type Raw = any;

const HEX_RE = /^[0-9a-f]+$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function base64ToHex(b64: string): string | undefined {
  try {
    const binary = atob(b64);
    let hex = "";
    for (let i = 0; i < binary.length; i++) {
      hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a trace/span id that may arrive as hex (already-decoded
 * protobuf, or a non-conformant JSON sender) or base64 (spec-conformant
 * OTLP/JSON `bytes` encoding) into lowercase hex. Workers-safe replacement for
 * Workshop's `normalizeOtelId`, which used `Buffer`.
 */
function normalizeOtlpId(
  value: string | undefined,
  expectedByteLength: number,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const expectedHexLength = expectedByteLength * 2;
  if (trimmed.length === expectedHexLength && HEX_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (!BASE64_RE.test(trimmed)) return trimmed;
  const hex = base64ToHex(trimmed);
  return hex && hex.length === expectedHexLength ? hex : trimmed;
}

function anyValueToJs(v: Raw): unknown {
  if (v == null) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) {
    return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  }
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.arrayValue) {
    return (v.arrayValue.values ?? []).map(anyValueToJs);
  }
  if (v.kvlistValue) {
    return attributesToRecord(v.kvlistValue.values);
  }
  return undefined;
}

function attributesToRecord(attrs: Raw[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) {
    if (!a?.key) continue;
    out[a.key] = anyValueToJs(a.value);
  }
  return out;
}

function statusCode(
  code: number | undefined,
): NormalizedOtlpSpan["statusCode"] {
  if (code === 1) return "ok";
  if (code === 2) return "error";
  return "unset";
}

function nsToMs(nanos: unknown): number {
  if (nanos === undefined || nanos === null || nanos === "0") return 0;
  return Number(BigInt(nanos as string | number) / 1_000_000n);
}

function normalizeSpan(s: Raw): NormalizedOtlpSpan {
  const endTimeMs = nsToMs(s.endTimeUnixNano);
  return {
    traceId: normalizeOtlpId(s.traceId, 16) ?? s.traceId ?? "",
    spanId: normalizeOtlpId(s.spanId, 8) ?? s.spanId ?? "",
    parentSpanId: normalizeOtlpId(s.parentSpanId || undefined, 8),
    name: s.name ?? "",
    startTimeMs: nsToMs(s.startTimeUnixNano),
    // OTLP always exports ended spans, so `0` (the unset field's zero value)
    // is indistinguishable from "not provided" — treat it as absent rather
    // than claim the span ended at the epoch.
    endTimeMs: endTimeMs > 0 ? endTimeMs : undefined,
    statusCode: statusCode(s.status?.code),
    statusMessage: s.status?.message || undefined,
    attributes: attributesToRecord(s.attributes),
    events:
      s.events && s.events.length > 0
        ? s.events.map((e: Raw) => ({
            name: e.name ?? "",
            timeMs: nsToMs(e.timeUnixNano),
            attributes: attributesToRecord(e.attributes),
          }))
        : undefined,
  };
}

/**
 * Flattens an OTLP `ExportTraceServiceRequest` (as decoded by
 * `decodeOtlpProtobuf`, or `JSON.parse`d directly) into a flat list of
 * {@link NormalizedOtlpSpan}s, in document order.
 */
export function normalizeOtlpRequest(body: Raw): NormalizedOtlpSpan[] {
  const spans: NormalizedOtlpSpan[] = [];
  for (const rs of body?.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        spans.push(normalizeSpan(s));
      }
    }
  }
  return spans;
}
