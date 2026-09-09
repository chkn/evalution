// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { toSafeImageSrc } from "./imageSrc.ts";

describe("toSafeImageSrc", () => {
  it("accepts an https URL", () => {
    expect(toSafeImageSrc("https://example.com/cat.png")).toBe(
      "https://example.com/cat.png",
    );
  });

  it("accepts an http URL", () => {
    expect(toSafeImageSrc("http://example.com/cat.png")).toBe(
      "http://example.com/cat.png",
    );
  });

  it("accepts a well-formed data: URI with a safe media type", () => {
    const src = toSafeImageSrc("data:image/png;base64,aGVsbG8=");
    expect(src).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("rejects a data: URI with an unsafe media type", () => {
    expect(toSafeImageSrc("data:text/html;base64,aGVsbG8=")).toBeNull();
  });

  it("rejects a data: URI with an unsafe media type embedding script content", () => {
    const payload = Buffer.from("<script>alert(1)</script>").toString("base64");
    expect(toSafeImageSrc(`data:text/html;base64,${payload}`)).toBeNull();
  });

  it("accepts a bare base64 payload paired with mediaType", () => {
    expect(toSafeImageSrc("aGVsbG8=", "image/jpeg")).toBe(
      "data:image/jpeg;base64,aGVsbG8=",
    );
  });

  it("rejects a bare payload with no safe mediaType", () => {
    expect(toSafeImageSrc("aGVsbG8=", "application/octet-stream")).toBeNull();
  });

  it("rejects a javascript: URL", () => {
    expect(toSafeImageSrc("javascript:alert(1)")).toBeNull();
  });

  it("rejects a protocol-relative URL", () => {
    expect(toSafeImageSrc("//evil.example/x.png")).toBeNull();
  });

  it("rejects garbage that is neither a URL nor valid base64", () => {
    expect(toSafeImageSrc("not base64 at all!!", "image/png")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(toSafeImageSrc("")).toBeNull();
  });

  it("defaults an image/* mediaType to image/png for a bare base64 payload", () => {
    expect(toSafeImageSrc("aGVsbG8=", "image/*")).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
  });
});
