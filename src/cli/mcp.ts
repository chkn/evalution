// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * `evalution mcp`: serves the project's API as an MCP server over stdio, for
 * a coding agent to launch (`npx evalution mcp`).
 *
 * A project's trace and dataset databases can be held open by one process at
 * a time. So one process — `evalution ui`, or the first `evalution mcp` —
 * holds them, serves MCP over HTTP, and records where (see
 * `./server-discovery.ts`). Every `evalution mcp` relays its agent's stdio to
 * that endpoint, its own included when it's the holder: several agent
 * sessions on one project share one server, and annotations they leave show
 * up live in an open UI.
 *
 * The holder can go away — its agent session ended, or the UI was stopped.
 * A relay then finds the new holder, or becomes it, and carries on: the
 * agent never notices, since the relay keeps the MCP session itself.
 */

import { serve } from "@hono/node-server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  isJSONRPCRequest,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Hono } from "hono";
import { MCP_CLIENT_HEADER } from "../mcp/server.ts";
import {
  type ApiContext,
  createProjectContext,
} from "../server/api-context.ts";
import { mountConfigRoute } from "../server/api-routes.ts";
import { mountMcp } from "../server/mcp-route.ts";
import { requestGuard } from "../server/request-guard.ts";
import type { ProjectProviders } from "./project.ts";
import {
  claimServerInfo,
  findRunningServer,
  removeServerInfo,
  writeServerInfo,
} from "./server-discovery.ts";

/**
 * Sends everything a library or a prompt module would print to stdout to
 * stderr instead: over stdio, stdout carries the protocol, and a stray line
 * on it breaks the connection.
 */
export function keepStdoutForProtocol(): void {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
}

/** A running {@link serveMcpOverHttp} server. */
export interface McpHttpServer {
  /** Where it listens, e.g. `http://127.0.0.1:53124`. */
  url: string;
  /** Resolves once no MCP request is being answered. */
  idle(): Promise<void>;
  /** Stops it. */
  close(): Promise<void>;
}

/**
 * Serves `context` over MCP at `/mcp` on a loopback port — `listenPort`, or
 * a free one — with the `/api/config` that `findRunningServer` checks a
 * server against: all a later `evalution mcp` needs to relay to this
 * process. `hasConfig` is whether the project has a config file, as
 * `/api/config` reports it.
 */
export async function serveMcpOverHttp(
  context: ApiContext,
  version: string,
  hasConfig: boolean,
  listenPort = 0,
): Promise<McpHttpServer> {
  const app = new Hono();
  app.use(requestGuard());
  mountConfigRoute(app, context.rootPath, hasConfig);
  const mcp = mountMcp(app, context, version);
  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>(resolve => {
    const server = serve(
      { fetch: app.fetch, port: listenPort, hostname: "127.0.0.1" },
      info => resolve({ server, port: info.port }),
    );
  });
  return {
    url: `http://127.0.0.1:${port}`,
    idle: () => mcp.idle(),
    close: () =>
      new Promise((resolve, reject) => {
        void mcp.close();
        if ("closeAllConnections" in server) server.closeAllConnections();
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

/** This process holding the project: see {@link serveMcpHolder}. */
export interface McpHolder {
  /** Where it serves MCP. */
  url: string;
  /** Resolves once no eval run is in flight here, and no MCP request is being answered. */
  idle(): Promise<void>;
}

/**
 * Serves `providers` over HTTP, in this process, for every `evalution mcp`
 * on the project — this one's included — and records where. The caller has
 * claimed the project ({@link claimServerInfo}).
 */
export async function serveMcpHolder(
  rootPath: string,
  providers: ProjectProviders,
  version: string,
  hasConfig: boolean,
): Promise<McpHolder> {
  const context = await createProjectContext({ ...providers, rootPath });
  const http = await serveMcpOverHttp(context, version, hasConfig);
  await writeServerInfo(rootPath, http.url, "mcp");
  console.error(`✨ Evalution MCP server running for ${rootPath}`);
  return {
    url: http.url,
    idle: async () => {
      // Either can start more of the other: a request starts a run, a run
      // ends and its relay asks for the results. Done once both are idle.
      for (;;) {
        await context.evalRunner?.idle();
        await http.idle();
        if (!context.evalRunner?.isBusy()) return;
      }
    },
  };
}

/**
 * The URL of the process serving the project at `rootDir`: the one running,
 * or — when there's none — this one, once `become` has made it the holder.
 * The project is claimed before `become` runs, so of several processes
 * looking at once, only one becomes the holder; the rest wait for it.
 */
export async function findOrBecomeHolder(
  rootDir: string,
  become: () => Promise<string>,
  { find = findRunningServer }: { find?: typeof findRunningServer } = {},
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    // Give a process that claimed the project between our looks a moment.
    if (attempt > 0) await new Promise(r => setTimeout(r, 200 * attempt));
    const running = await find(rootDir);
    if (running) return running.url;
    if (await claimServerInfo(rootDir, "mcp")) {
      try {
        return await become();
      } catch (err) {
        removeServerInfo(rootDir);
        throw err;
      }
    }
  }
  throw new Error(
    `Couldn't find or start an evalution server for ${rootDir}: another process has claimed it but isn't serving.`,
  );
}

/** Options for {@link relayMcp}. */
export interface RelayMcpOptions {
  /**
   * Called when the server can't be reached: the URL of the server to
   * carry on with (see {@link findOrBecomeHolder}). Without it, or when it
   * fails, the relay ends.
   */
  reconnect?: () => Promise<string>;
}

/**
 * Relays MCP messages between `local` (the agent's side) and the `/mcp`
 * endpoint of the server at `serverUrl`, message for message, until either
 * side goes away; then calls `onEnd` — with why, if it's because no server
 * could be reached.
 *
 * When the server can't be reached, the relay switches to the one
 * `reconnect` names, replaying the agent's `initialize` to it, and resends.
 * A request no server can be reached for is answered with an error rather
 * than left hanging, and ends the relay.
 */
export async function relayMcp(
  local: Transport,
  serverUrl: string,
  onEnd: (failure?: string) => void,
  { reconnect }: RelayMcpOptions = {},
): Promise<void> {
  // A 2025-era client is served statelessly over HTTP, so the server never
  // sees its `initialize`; pass its name along on every request instead.
  let clientName: string | undefined;
  // Replayed to a new server, which hasn't seen the session start.
  let initialize: JSONRPCMessage | undefined;
  let initialized: JSONRPCMessage | undefined;
  const replayIds = new Set<string>();
  // Requests the agent is waiting on, each answered exactly once: by a
  // server, or with an error when none can. When the server a request went
  // to goes away mid-answer, the agent is told rather than left waiting.
  // They aren't resent — a tool call may not be safe to repeat.
  const pending = new Map<
    string,
    {
      id: RequestId;
      /** The server it went to, once it's being sent. */
      transport?: StreamableHTTPClientTransport;
      /** Set once `send` has returned; until then a failure is the sender's to handle. */
      sent?: boolean;
    }
  >();

  /** Answers the pending request `key` with an error, if it's still waiting. */
  const fail = async (key: string, message: string): Promise<void> => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    await local
      .send({ jsonrpc: "2.0", id: entry.id, error: { code: -32603, message } })
      .catch(() => {});
  };

  let ended = false;
  const end = (failure?: string) => {
    if (ended) return;
    ended = true;
    void remote.close().catch(() => {});
    // Whichever failure ends the relay, a request still waiting gets its
    // reason before the agent's side closes, rather than "connection closed".
    const answered =
      failure === undefined
        ? []
        : [...pending.keys()].map(key =>
            fail(
              key,
              `${failure}. Restart the evalution MCP server to reconnect.`,
            ),
          );
    void Promise.all(answered).then(() => {
      void local.close().catch(() => {});
      onEnd(failure);
    });
  };

  const connect = async (url: string) => {
    // Which server answers at `url` — see `instanceAt`. Set once connected.
    let instance: string | undefined;
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", url), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (clientName) headers.set(MCP_CLIENT_HEADER, clientName);
        return fetch(input, { ...init, headers });
      },
    });
    transport.onmessage = message => {
      if ("id" in message && !("method" in message)) {
        // The new server's answer to a replayed `initialize` is the relay's.
        if (replayIds.delete(String(message.id))) return;
        pending.delete(String(message.id));
      } else if (transport !== remote) {
        return;
      }
      void local.send(message);
    };
    transport.onerror = err => {
      // Only a request already sent can be stranded by a broken stream; one
      // still being sent fails its `send`, and its sender handles that.
      if (![...pending.values()].some(p => p.transport === transport && p.sent))
        return;
      // A response stream broke. If it's because the server is gone, the
      // requests it was answering never will be.
      // Still up only if it's the same server: one restarted on the same
      // port can't resume the streams the old one was answering.
      void instanceAt(url).then(now => {
        if (now !== undefined && now === instance) {
          console.error("MCP relay error:", err);
          return;
        }
        abandon(transport, url);
        if (transport !== remote || ended) return;
        if (!reconnect) {
          end(`The evalution server at ${url} went away`);
          return;
        }
        switchServer(transport).catch((switchErr: unknown) =>
          end(
            `Could not reach the evalution server at ${url}: ${switchErr instanceof Error ? switchErr.message : String(switchErr)}`,
          ),
        );
      });
    };
    transport.onclose = () => {
      if (transport === remote && !reconnect) {
        end(`The evalution server at ${url} closed`);
      }
    };
    await transport.start();
    instance = await instanceAt(url);
    return transport;
  };

  let remote = await connect(serverUrl);
  let remoteUrl = serverUrl;
  let switching: Promise<void> | undefined;

  /** Moves to the server `reconnect` names, once for any number of failed sends. */
  const switchServer = (from: StreamableHTTPClientTransport) => {
    if (remote !== from) return switching ?? Promise.resolve();
    switching ??= (async () => {
      const url = await reconnect!();
      const next = await connect(url);
      const previous = remote;
      const previousUrl = remoteUrl;
      remote = next;
      remoteUrl = url;
      abandon(previous, previousUrl);
      void previous.close().catch(() => {});
      if (initialize && "id" in initialize) {
        const id = `evalution-relay-replay-${replayIds.size}-${Date.now()}`;
        replayIds.add(id);
        await next.send({ ...initialize, id } as JSONRPCMessage);
        if (initialized) await next.send(initialized);
      }
    })().finally(() => {
      switching = undefined;
    });
    return switching;
  };

  /** Answers every request sent to `transport` and still waiting with an error. */
  const abandon = (transport: StreamableHTTPClientTransport, url: string) => {
    for (const [key, entry] of pending) {
      if (entry.transport !== transport || !entry.sent) continue;
      void fail(
        key,
        `The evalution server at ${url} went away while answering this request, which may or may not have taken effect. Check, then retry if needed.`,
      );
    }
  };

  const forward = async (message: JSONRPCMessage) => {
    await switching;
    let target = remote;
    const key = isJSONRPCRequest(message) ? String(message.id) : undefined;
    /** Sends to `target`, noting where a request went until it's answered. */
    const sendTracked = async () => {
      const entry = key === undefined ? undefined : pending.get(key);
      if (!entry) {
        // A notification — or a request already answered, as the relay ended.
        if (key === undefined) await target.send(message);
        return;
      }
      // Noted before it's sent: its answer can arrive before `send` returns.
      entry.transport = target;
      entry.sent = false;
      try {
        await target.send(message);
        entry.sent = true;
      } catch (err) {
        // Still waiting, but on no server: the sender answers or resends it.
        entry.transport = undefined;
        throw err;
      }
    };
    try {
      await sendTracked();
    } catch (err) {
      if (!reconnect) throw err;
      await switchServer(target);
      target = remote;
      await sendTracked();
    }
  };

  local.onmessage = (message: JSONRPCMessage) => {
    if (isJSONRPCRequest(message) && message.method === "initialize") {
      const info = (message.params as { clientInfo?: { name?: unknown } })
        ?.clientInfo;
      if (typeof info?.name === "string") clientName = info.name;
      initialize = message;
    } else if (
      "method" in message &&
      message.method === "notifications/initialized"
    ) {
      initialized = message;
    }
    if (isJSONRPCRequest(message)) {
      pending.set(String(message.id), { id: message.id });
    }
    forward(message).catch((err: unknown) => {
      // `end` answers this request, if it's still waiting, with the reason.
      end(
        `Could not reach the evalution server at ${remoteUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  local.onclose = () => end();
  await local.start();
}

/** Options for {@link relayMcpToServer}. */
export interface RelayMcpToServerOptions extends RelayMcpOptions {
  /** Runs before the process exits, once the relay has ended. */
  beforeExit?: () => Promise<void>;
}

/** The `instance` id of the server at `url` (see `mountConfigRoute`), or `undefined` when none answers. */
async function instanceAt(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(new URL("/api/config", url), {
      signal: AbortSignal.timeout(1000),
    });
    const { instance } = (await res.json()) as { instance?: unknown };
    return typeof instance === "string" ? instance : "";
  } catch {
    return undefined;
  }
}

/**
 * Relays stdio to the server at `serverUrl` — see {@link relayMcp} — exiting
 * when the relay ends: file watchers would otherwise keep the process alive.
 */
export async function relayMcpToServer(
  serverUrl: string,
  { beforeExit, ...options }: RelayMcpToServerOptions = {},
): Promise<void> {
  let exiting = false;
  const exit = async (failure?: string) => {
    if (exiting) return;
    exiting = true;
    if (failure) console.error(failure);
    await beforeExit?.().catch(err => console.error(err));
    process.exit(failure ? 1 : 0);
  };
  await relayMcp(new StdioServerTransport(), serverUrl, exit, options);
  process.stdin.once("end", () => void exit());
  process.stdin.once("close", () => void exit());
  console.error(`✨ Evalution MCP relaying to ${serverUrl}`);
}
