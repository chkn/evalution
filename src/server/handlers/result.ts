// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What every runtime-neutral handler in this directory returns: an HTTP-style
 * status and a JSON-able body. The REST routes relay it as a response; the
 * MCP server relays it as a tool result (an error when `status >= 400`).
 */
export interface HandlerResult {
  status: number;
  /** The response body; `undefined` for a 204. */
  body: unknown;
}

/** A handler result carrying `{ error: message }`. */
export function errorResult(status: number, message: string): HandlerResult {
  return { status, body: { error: message } };
}
