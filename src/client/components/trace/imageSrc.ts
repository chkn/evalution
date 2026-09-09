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

/**
 * Validates a `SpanImagePart`'s `image` value into something safe to hand to
 * an `<img src>` — ported from the security-relevant half of Workshop's
 * `utils/messageParsing.ts` (`toImageSrc`/`safeInlineMediaType`/
 * `normalizeBase64`/`safeRemoteImageUrl`).
 */

const MAX_INLINE_IMAGE_BASE64_CHARS = 10 * 1024 * 1024;
const SAFE_INLINE_IMAGE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function safeInlineMediaType(mediaType?: string): string | null {
  const normalized = mediaType?.trim().toLowerCase();
  if (!normalized || normalized === "image/*") return "image/png";
  return SAFE_INLINE_IMAGE_MEDIA_TYPES.has(normalized) ? normalized : null;
}

function normalizeBase64(value: string): string | null {
  if (value.length > MAX_INLINE_IMAGE_BASE64_CHARS) return null;
  const compact = value.replace(/\s/g, "");
  if (
    !compact ||
    compact.length > MAX_INLINE_IMAGE_BASE64_CHARS ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    return null;
  }
  return compact;
}

function safeRemoteImageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Returns a browser-safe `<img src>` for an image part's raw value, or `null`
 * if it can't be validated as one — an http(s) URL, an already-encoded
 * `data:` URI, or a bare base64 payload paired with `mediaType`. Rejects
 * anything else (in particular `javascript:`/other schemes) so a crafted
 * span never turns into script execution via an `<img>` tag.
 */
export function toSafeImageSrc(
  value: string,
  mediaType?: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^https?:/i.test(trimmed)) return safeRemoteImageUrl(trimmed);

  if (/^data:/i.test(trimmed)) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(trimmed);
    if (!match) return null;
    const safeMediaType = safeInlineMediaType(match[1]);
    const base64 = normalizeBase64(match[2]);
    return safeMediaType && base64
      ? `data:${safeMediaType};base64,${base64}`
      : null;
  }

  // Any other URL scheme (or a protocol-relative `//…`) is rejected outright
  // rather than treated as inline base64.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//"))
    return null;

  const safeMediaType = safeInlineMediaType(mediaType);
  const base64 = normalizeBase64(trimmed);
  return safeMediaType && base64
    ? `data:${safeMediaType};base64,${base64}`
    : null;
}
