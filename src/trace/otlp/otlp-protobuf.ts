// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
// Copyright (c) 2026 Invisible Tools, Inc. (dba Raindrop)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// This file was adapted from Workshop's `src/otlp-protobuf.ts`, and now
// decodes the wire format by hand instead of with protobufjs: protobufjs
// builds its decoders with `new Function`, which Cloudflare Workers refuse
// ("Code generation from strings disallowed for this context").
//
// The messages it reads, from opentelemetry-proto's trace/v1/trace.proto,
// common/v1/common.proto and resource/v1/resource.proto (fields this file
// doesn't list are skipped):
//
//   ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
//   ResourceSpans   { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
//   Resource        { repeated KeyValue attributes = 1; }
//   ScopeSpans      { InstrumentationScope scope = 1; repeated Span spans = 2; }
//   InstrumentationScope { string name = 1; string version = 2; }
//   Span {
//     bytes trace_id = 1; bytes span_id = 2; string trace_state = 3;
//     bytes parent_span_id = 4; string name = 5; SpanKind kind = 6;
//     fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
//     repeated KeyValue attributes = 9; repeated Event events = 11;
//     repeated Link links = 13; Status status = 15;
//   }
//   Event  { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
//   Link   { bytes trace_id = 1; bytes span_id = 2; repeated KeyValue attributes = 4; }
//   Status { string message = 2; StatusCode code = 3; }
//   KeyValue { string key = 1; AnyValue value = 2; }
//   AnyValue { oneof value {
//     string string_value = 1; bool bool_value = 2; int64 int_value = 3;
//     double double_value = 4; ArrayValue array_value = 5;
//     KeyValueList kvlist_value = 6; bytes bytes_value = 7;
//   } }
//   ArrayValue   { repeated AnyValue values = 1; }
//   KeyValueList { repeated KeyValue values = 1; }

const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED32 = 5;

// Lenient, like protobufjs: a bad byte in one string shouldn't drop the batch.
const utf8 = new TextDecoder();

/** A cursor over one message's bytes. */
class Reader {
  private pos = 0;
  private readonly buf: Uint8Array;
  private readonly view: DataView;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** Calls `onField` with each field's number and wire type, in order. */
  forEachField(onField: (field: number, wireType: number) => boolean): void {
    while (this.pos < this.buf.length) {
      const tag = this.varint();
      const field = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (field === 0) throw new Error("invalid field number 0");
      if (!onField(field, wireType)) this.skip(wireType);
    }
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.buf.length) throw new Error("truncated varint");
      const byte = this.buf[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return BigInt.asUintN(64, result);
    }
    throw new Error("varint too long");
  }

  fixed64(): bigint {
    this.need(8);
    const value = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return value;
  }

  double(): number {
    this.need(8);
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return value;
  }

  bytes(): Uint8Array {
    const length = Number(this.varint());
    this.need(length);
    const value = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

  string(): string {
    return utf8.decode(this.bytes());
  }

  /** Decodes a length-delimited submessage with `decode`. */
  message<T>(decode: (r: Reader) => T): T {
    return decode(new Reader(this.bytes()));
  }

  private skip(wireType: number): void {
    switch (wireType) {
      case VARINT:
        this.varint();
        return;
      case FIXED64:
        this.need(8);
        this.pos += 8;
        return;
      case LENGTH_DELIMITED:
        this.bytes();
        return;
      case FIXED32:
        this.need(4);
        this.pos += 4;
        return;
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }

  private need(length: number): void {
    if (this.pos + length > this.buf.length) {
      throw new Error("truncated message");
    }
  }
}

function bytesToHex(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

// The OTLP/JSON shapes these return: camelCase keys, hex ids, and 64-bit
// values as decimal strings.

function decodeAnyValue(r: Reader): any {
  // A oneof: when a sender writes more than one alternative, the last wins.
  let value: any;
  r.forEachField((field, wireType) => {
    if (field === 1 && wireType === LENGTH_DELIMITED)
      value = { stringValue: r.string() };
    else if (field === 2 && wireType === VARINT)
      value = { boolValue: r.varint() !== 0n };
    else if (field === 3 && wireType === VARINT)
      value = { intValue: String(BigInt.asIntN(64, r.varint())) };
    else if (field === 4 && wireType === FIXED64)
      value = { doubleValue: r.double() };
    else if (field === 5 && wireType === LENGTH_DELIMITED)
      value = {
        arrayValue: { values: r.message(decodeRepeated(decodeAnyValue)) },
      };
    else if (field === 6 && wireType === LENGTH_DELIMITED)
      value = {
        kvlistValue: { values: r.message(decodeRepeated(decodeKeyValue)) },
      };
    else if (field === 7 && wireType === LENGTH_DELIMITED)
      value = { stringValue: bytesToHex(r.bytes()) ?? "" };
    else return false;
    return true;
  });
  return value;
}

/**
 * Decodes a message whose one field read here is a repeated submessage at
 * field 1: `ArrayValue`, `KeyValueList`, `Resource` and
 * `ExportTraceServiceRequest`.
 */
function decodeRepeated<T>(decode: (r: Reader) => T): (r: Reader) => T[] {
  return r => {
    const values: T[] = [];
    r.forEachField((field, wireType) => {
      if (field !== 1 || wireType !== LENGTH_DELIMITED) return false;
      values.push(r.message(decode));
      return true;
    });
    return values;
  };
}

function decodeKeyValue(r: Reader): any {
  let key = "";
  let value: any;
  r.forEachField((field, wireType) => {
    if (wireType !== LENGTH_DELIMITED) return false;
    if (field === 1) key = r.string();
    else if (field === 2) value = r.message(decodeAnyValue);
    else return false;
    return true;
  });
  return { key, value };
}

function decodeStatus(r: Reader): any {
  const status: { code: number; message?: string } = { code: 0 };
  r.forEachField((field, wireType) => {
    if (field === 2 && wireType === LENGTH_DELIMITED)
      status.message = r.string();
    else if (field === 3 && wireType === VARINT)
      status.code = Number(BigInt.asIntN(32, r.varint()));
    else return false;
    return true;
  });
  return status;
}

function decodeEvent(r: Reader): any {
  const event = { timeUnixNano: "0", name: "", attributes: [] as any[] };
  r.forEachField((field, wireType) => {
    if (field === 1 && wireType === FIXED64)
      event.timeUnixNano = String(r.fixed64());
    else if (field === 2 && wireType === LENGTH_DELIMITED)
      event.name = r.string();
    else if (field === 3 && wireType === LENGTH_DELIMITED)
      event.attributes.push(r.message(decodeKeyValue));
    else return false;
    return true;
  });
  return event;
}

function decodeLink(r: Reader): any {
  const link = { traceId: "", spanId: "", attributes: [] as any[] };
  r.forEachField((field, wireType) => {
    if (wireType !== LENGTH_DELIMITED) return false;
    if (field === 1) link.traceId = bytesToHex(r.bytes()) ?? "";
    else if (field === 2) link.spanId = bytesToHex(r.bytes()) ?? "";
    else if (field === 4) link.attributes.push(r.message(decodeKeyValue));
    else return false;
    return true;
  });
  return link;
}

function decodeSpan(r: Reader): any {
  const span: any = {
    traceId: "",
    spanId: "",
    parentSpanId: undefined,
    traceState: undefined,
    name: "",
    kind: 0,
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    attributes: [],
    events: [],
    links: [],
    status: undefined,
  };
  r.forEachField((field, wireType) => {
    if (wireType === LENGTH_DELIMITED) {
      if (field === 1) span.traceId = bytesToHex(r.bytes()) ?? "";
      else if (field === 2) span.spanId = bytesToHex(r.bytes()) ?? "";
      else if (field === 3) span.traceState = r.string() || undefined;
      else if (field === 4) span.parentSpanId = bytesToHex(r.bytes());
      else if (field === 5) span.name = r.string();
      else if (field === 9) span.attributes.push(r.message(decodeKeyValue));
      else if (field === 11) span.events.push(r.message(decodeEvent));
      else if (field === 13) span.links.push(r.message(decodeLink));
      else if (field === 15) span.status = r.message(decodeStatus);
      else return false;
    } else if (field === 6 && wireType === VARINT) {
      span.kind = Number(BigInt.asIntN(32, r.varint()));
    } else if (field === 7 && wireType === FIXED64) {
      span.startTimeUnixNano = String(r.fixed64());
    } else if (field === 8 && wireType === FIXED64) {
      span.endTimeUnixNano = String(r.fixed64());
    } else return false;
    return true;
  });
  return span;
}

function decodeScope(r: Reader): any {
  const scope: { name: string; version?: string } = { name: "" };
  r.forEachField((field, wireType) => {
    if (wireType !== LENGTH_DELIMITED) return false;
    if (field === 1) scope.name = r.string();
    else if (field === 2) scope.version = r.string() || undefined;
    else return false;
    return true;
  });
  return scope;
}

function decodeScopeSpans(r: Reader): any {
  const scopeSpans: { scope?: any; spans: any[] } = {
    scope: undefined,
    spans: [],
  };
  r.forEachField((field, wireType) => {
    if (wireType !== LENGTH_DELIMITED) return false;
    if (field === 1) scopeSpans.scope = r.message(decodeScope);
    else if (field === 2) scopeSpans.spans.push(r.message(decodeSpan));
    else return false;
    return true;
  });
  return scopeSpans;
}

function decodeResource(r: Reader): any {
  return { attributes: decodeRepeated(decodeKeyValue)(r) };
}

function decodeResourceSpans(r: Reader): any {
  const resourceSpans = {
    resource: { attributes: [] },
    scopeSpans: [] as any[],
  };
  r.forEachField((field, wireType) => {
    if (wireType !== LENGTH_DELIMITED) return false;
    if (field === 1) resourceSpans.resource = r.message(decodeResource);
    else if (field === 2)
      resourceSpans.scopeSpans.push(r.message(decodeScopeSpans));
    else return false;
    return true;
  });
  return resourceSpans;
}

/**
 * Decodes an OTLP/protobuf `ExportTraceServiceRequest` payload into the same
 * plain-object shape as the OTLP/JSON encoding (camelCase keys, hex trace/span
 * ids, stringified 64-bit values) — so `../otlp/normalize.ts` can walk either
 * with one function. Throws on a payload that isn't well-formed protobuf.
 */
export function decodeOtlpProtobuf(buf: Uint8Array): { resourceSpans: any[] } {
  return {
    resourceSpans: decodeRepeated(decodeResourceSpans)(new Reader(buf)),
  };
}
