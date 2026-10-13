// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The document a view's frame loads, and the policies that sandbox it. See
 * `specs/trace-visualizers.md` §B.3.
 */

import { VIEW_FRAME_PATH } from "../shared/view-surfaces.ts";
import type { ViewBundle } from "./view-registry.ts";

/**
 * The frame document's policy. `sandbox` without `allow-same-origin` gives
 * it an opaque origin, even when it's opened directly; `default-src 'none'`
 * keeps it off the network, and only its own inline script runs.
 */
export function viewFrameCsp(nonce: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "form-action 'none'",
  ].join("; ");
}

/**
 * The host page's policy: frames may only load the frame route. Browsers
 * check it on every navigation of a child frame, whoever starts it, so a
 * view can't navigate its frame elsewhere — carrying data in the URL — and
 * no request is sent. `host` is the page's own `Host`; an `http:` source
 * also matches `https:`.
 */
export function hostPageCsp(host: string): string {
  return `frame-src http://${host}${VIEW_FRAME_PATH}`;
}

/** `code` made safe to inline in a `<script>` element. */
function inlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** The frame's whole document: the view's bundle, inline, run with `nonce`. */
export function viewFrameDocument(bundle: ViewBundle, nonce: string): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "</head><body>",
    `<script type="module" nonce="${nonce}">${inlineScript(bundle.code)}</script>`,
    "</body></html>",
  ].join("");
}
