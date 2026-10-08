// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Keeps other websites out of the local server, which has no authentication.
 *
 * Browsers let any page send requests to `localhost` (a form post, or a
 * `fetch` with a `text/plain` body, needs no CORS preflight) and open
 * WebSockets to it, and a site can point its own hostname at `127.0.0.1`
 * (DNS rebinding) to read the responses too. So every request must be
 * addressed to a host the server is actually reached at, and one a browser
 * sends on a page's behalf must come from a page that host served.
 */

import net from "node:net";
import type { MiddlewareHandler } from "hono";

/** What {@link requestGuard} accepts beyond the hosts it always does. */
export interface RequestGuardOptions {
  /**
   * Hostnames the server is also reached at, e.g. the name `--host` was given
   * or a proxy's (`evalution.myapp.test`). Compared case-insensitively.
   */
  allowedHosts?: readonly string[];
}

/**
 * Why a request with these `host` and `origin` headers must be refused, or
 * `undefined` if it may proceed.
 *
 * - `Host` must name `localhost`, a `*.localhost` subdomain (which only ever
 *   resolves to loopback), an IP address, or one of `allowedHosts`: a name
 *   that DNS rebinding could point here is anything else.
 * - `Origin`, when there is one, must be a page on a loopback host or one of
 *   `allowedHosts`, or the very host the request is addressed to. Requests
 *   that aren't from a browser carry no `Origin` and pass on `Host` alone.
 */
export function requestRefusal(
  host: string | null | undefined,
  origin: string | null | undefined,
  allowedHosts: readonly string[] = [],
): string | undefined {
  const allowed = new Set(allowedHosts.map(h => h.toLowerCase()));
  // Parsed, so it compares with `Origin`'s normalized form below.
  const hostUrl = host ? parseUrl(`http://${host}`) : undefined;
  if (host) {
    const hostname = hostUrl?.hostname;
    if (
      !hostname ||
      !(isLocalhost(hostname) || isIpAddress(hostname) || allowed.has(hostname))
    )
      return `Host '${host}' isn't one this server answers to`;
  }
  if (origin) {
    // `null` (sandboxed frames, `file:` pages) doesn't parse, so is refused.
    const url = parseUrl(origin);
    if (
      url === undefined ||
      !(
        url.host === hostUrl?.host ||
        isLoopback(url.hostname) ||
        allowed.has(url.hostname)
      )
    )
      return `Requests from '${origin}' aren't allowed`;
  }
  return undefined;
}

/**
 * Hono middleware answering 403 to any request {@link requestRefusal}
 * refuses — WebSocket handshakes included, which then never upgrade.
 * Registered ahead of every route on the Node servers.
 */
export function requestGuard(
  options: RequestGuardOptions = {},
): MiddlewareHandler {
  return async (c, next) => {
    const refusal = requestRefusal(
      c.req.header("host"),
      c.req.header("origin"),
      options.allowedHosts,
    );
    if (refusal) return c.json({ error: refusal }, 403);
    await next();
  };
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** `localhost` or a subdomain of it, which resolve to loopback (RFC 6761). */
function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/** Whether `hostname` is a loopback name or address. */
function isLoopback(hostname: string): boolean {
  return (
    isLocalhost(hostname) ||
    hostname === "[::1]" ||
    (net.isIPv4(hostname) && hostname.startsWith("127."))
  );
}

/** Whether `hostname` is an IPv4 address or a bracketed IPv6 one. */
function isIpAddress(hostname: string): boolean {
  return (
    net.isIPv4(hostname) ||
    (hostname.startsWith("[") && net.isIPv6(hostname.slice(1, -1)))
  );
}
