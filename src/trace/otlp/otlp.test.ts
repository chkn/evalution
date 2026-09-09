// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";
import { normalizeOtlpRequest } from "./normalize.ts";
import { decodeOtlpProtobuf } from "./otlp-protobuf.ts";

// A standalone encoder for these tests only — real OTLP senders (SDKs,
// collectors) do this; evalution only ever decodes. Mirrors the wire shape in
// `otlp-protobuf.ts`'s `OTLP_PROTO`.
const TEST_PROTO = `
syntax = "proto3";
package otlp;
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Status { string message = 2; int32 code = 3; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  bytes parent_span_id = 4;
  string name = 5;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  Status status = 15;
}
message ScopeSpans { repeated Span spans = 2; }
message ResourceSpans { repeated ScopeSpans scope_spans = 2; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
`;
const testRoot = protobuf.parse(TEST_PROTO, { keepCase: false }).root;
const TestRequest = testRoot.lookupType("otlp.ExportTraceServiceRequest");

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeTestRequest(spans: any[]): Uint8Array {
  const msg = TestRequest.create({
    resourceSpans: [{ scopeSpans: [{ spans }] }],
  });
  return TestRequest.encode(msg).finish();
}

describe("decodeOtlpProtobuf + normalizeOtlpRequest", () => {
  it("round-trips ids, timestamps, attributes and status through the wire format", () => {
    const bytes = encodeTestRequest([
      {
        traceId: hexToBytes("0102030405060708090a0b0c0d0e0f10"),
        spanId: hexToBytes("0102030405060708"),
        name: "chat",
        startTimeUnixNano: "1000000000",
        endTimeUnixNano: "2500000000",
        attributes: [
          { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
          { key: "gen_ai.usage.input_tokens", value: { intValue: "42" } },
          { key: "temperature", value: { doubleValue: 0.7 } },
          {
            key: "tags",
            value: {
              arrayValue: {
                values: [{ stringValue: "a" }, { stringValue: "b" }],
              },
            },
          },
        ],
        status: { code: 1 },
      },
    ]);

    const decoded = decodeOtlpProtobuf(bytes);
    const [span] = normalizeOtlpRequest(decoded);

    expect(span.traceId).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(span.spanId).toBe("0102030405060708");
    expect(span.parentSpanId).toBeUndefined();
    expect(span.name).toBe("chat");
    expect(span.startTimeMs).toBe(1000);
    expect(span.endTimeMs).toBe(2500);
    expect(span.statusCode).toBe("ok");
    expect(span.attributes).toEqual({
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.usage.input_tokens": 42,
      temperature: 0.7,
      tags: ["a", "b"],
    });
  });

  it("normalizes an error status and keeps the message", () => {
    const bytes = encodeTestRequest([
      {
        traceId: hexToBytes("11111111111111111111111111111111"),
        spanId: hexToBytes("2222222222222222"),
        parentSpanId: hexToBytes("3333333333333333"),
        name: "tool",
        status: { code: 2, message: "boom" },
      },
    ]);

    const [span] = normalizeOtlpRequest(decodeOtlpProtobuf(bytes));
    expect(span.parentSpanId).toBe("3333333333333333");
    expect(span.statusCode).toBe("error");
    expect(span.statusMessage).toBe("boom");
    // No end time on the wire → absent, not epoch-zero.
    expect(span.endTimeMs).toBeUndefined();
  });
});

describe("normalizeOtlpRequest over OTLP/JSON", () => {
  it("accepts base64 ids (the spec-conformant JSON `bytes` encoding)", () => {
    // trace_id/span_id are `bytes` fields; OTLP/JSON base64-encodes them,
    // unlike the hex the protobuf decoder above already produces.
    const traceIdBytes = hexToBytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const spanIdBytes = hexToBytes("bbbbbbbbbbbbbbbb");
    const traceIdB64 = Buffer.from(traceIdBytes).toString("base64");
    const spanIdB64 = Buffer.from(spanIdBytes).toString("base64");

    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceIdB64,
                  spanId: spanIdB64,
                  name: "json-span",
                  startTimeUnixNano: "5000000",
                  endTimeUnixNano: "9000000",
                  attributes: [{ key: "k", value: { stringValue: "v" } }],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };

    const [span] = normalizeOtlpRequest(body);
    expect(span.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(span.spanId).toBe("bbbbbbbbbbbbbbbb");
    expect(span.startTimeMs).toBe(5);
    expect(span.endTimeMs).toBe(9);
    expect(span.attributes).toEqual({ k: "v" });
  });

  it("passes through an already-hex id unchanged (non-conformant but common)", () => {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "cccccccccccccccccccccccccccccccc",
                  spanId: "dddddddddddddddd",
                  name: "hex-json-span",
                },
              ],
            },
          ],
        },
      ],
    };
    const [span] = normalizeOtlpRequest(body);
    expect(span.traceId).toBe("cccccccccccccccccccccccccccccccc");
    expect(span.spanId).toBe("dddddddddddddddd");
  });
});
