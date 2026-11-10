// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

// Node only, and loaded only on Node. `node:` modules are imported where
// they're used, so bundling this for another runtime still produces a module
// that loads there.

import type { HttpTraceTarget } from "./http-trace-sink.ts";

const SERVICES_URL = "https://portkit.localhost/services";

/** How long to wait for portkit to answer; Caddy may be starting. */
const DISCOVERY_TIMEOUT_MS = 1000;

/**
 * How long to wait for a response when the caller sets no limit. Just over the
 * 60 s portkit holds a request while an on-demand service starts.
 */
const REQUEST_TIMEOUT_MS = 65_000;

/** Options for {@link discoverPortkit}. Tests point these at a local server. */
export interface PortkitDiscoveryOptions {
  /** Defaults to the process's environment. */
  env?: Record<string, string | undefined>;
  /** The directory to find a service for. Defaults to the process's. */
  cwd?: string;
  /** Defaults to portkit's own discovery URL. */
  servicesUrl?: string;
}

/**
 * Asks portkit for the evalution instance serving this directory or one of
 * its parents. It never contacts the service itself, which would start one
 * that's on demand.
 *
 * Resolves to `undefined` when portkit isn't installed — without its CA
 * certificate no request is made — or has no such service, or doesn't answer
 * in time.
 */
export async function discoverPortkit({
  env = process.env,
  cwd = process.cwd(),
  servicesUrl = SERVICES_URL,
}: PortkitDiscoveryOptions = {}): Promise<HttpTraceTarget | undefined> {
  try {
    const ca = await readPortkitCa(env);
    const send = localTlsFetch(ca);
    const query = new URLSearchParams({ label: "kind=evalution", cwd });
    const res = await send(`${servicesUrl}?${query}`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const { services } = (await res.json()) as {
      services?: { url?: string }[];
    };
    const endpoint = services?.[0]?.url;
    return endpoint ? { endpoint, fetch: send } : undefined;
  } catch {
    return undefined;
  }
}

async function readPortkitCa(
  env: Record<string, string | undefined>,
): Promise<string> {
  const [{ readFile }, { homedir }, { join }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  const home =
    env.PORTKIT_HOME ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "portkit")
      : join(homedir(), ".local", "share", "portkit"));
  return readFile(
    join(home, "data", "caddy", "pki", "authorities", "local", "root.crt"),
    "utf8",
  );
}

/**
 * A `fetch` for portkit's `*.localhost` names. It connects to loopback whatever
 * the name, since not every system resolves `*.localhost`, and trusts `ca` for
 * these connections only.
 *
 * Takes what this package sends: a URL, and a string body.
 */
export function localTlsFetch(ca: string): typeof fetch {
  return async (input, init) => {
    const { request } = await import("node:https");
    const url = new URL(String(input));
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: url.port || 443,
          servername: url.hostname,
          path: url.pathname + url.search,
          method: init?.method ?? "GET",
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            host: url.host,
          },
          ca,
          signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const body = chunks.length > 0 ? Buffer.concat(chunks) : null;
            resolve(new Response(body, { status: res.statusCode }));
          });
        },
      );
      req.on("error", reject);
      req.end(init?.body as string | undefined);
    });
  };
}
