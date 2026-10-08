// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import net from "node:net";

/**
 * The address the playground server listens on unless told otherwise:
 * loopback only, so nothing else on the network can reach it.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * The URL to open (and to hand launched agents) for a server listening on
 * `host`:`port`. Loopback and the wildcard addresses are reached as
 * `localhost` — the origin the playground has always been opened at, so a
 * browser keeps its saved state for it — and an IPv6 address is bracketed.
 */
export function serverUrl(host: string, port: number): string {
  if (["127.0.0.1", "0.0.0.0", "::"].includes(host))
    return `http://localhost:${port}`;
  return net.isIPv6(host)
    ? `http://[${host}]:${port}`
    : `http://${host}:${port}`;
}
