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
  /** Stops it. */
  close(): Promise<void>;
}

/**
 * Serves `context` over MCP at `/mcp` on a free loopback port, with the
 * `/api/config` that `findRunningServer` checks a server against — all a
 * later `evalution mcp` needs to relay to this process. `hasConfig` is
 * whether the project has a config file, as `/api/config` reports it.
 */
export async function serveMcpOverHttp(
  context: ApiContext,
  version: string,
  hasConfig: boolean,
): Promise<McpHttpServer> {
  const app = new Hono();
  mountConfigRoute(app, context.rootPath, hasConfig);
  const mcp = mountMcp(app, context, version);
  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>(resolve => {
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      info => resolve({ server, port: info.port }),
    );
  });
  return {
    url: `http://127.0.0.1:${port}`,
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
  /** Resolves once no eval run is in flight here. */
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
      await context.evalRunner?.idle();
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

  let ended = false;
  const end = (failure?: string) => {
    if (ended) return;
    ended = true;
    void remote.close().catch(() => {});
    void local.close().catch(() => {});
    onEnd(failure);
  };

  const connect = async (url: string) => {
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", url), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (clientName) headers.set(MCP_CLIENT_HEADER, clientName);
        return fetch(input, { ...init, headers });
      },
    });
    transport.onmessage = message => {
      if (transport !== remote) return;
      // The new server's answer to a replayed `initialize` is the relay's.
      if ("id" in message && replayIds.delete(String(message.id))) return;
      void local.send(message);
    };
    transport.onerror = err => console.error("MCP relay error:", err);
    transport.onclose = () => {
      if (transport === remote && !reconnect) {
        end(`The evalution server at ${url} closed`);
      }
    };
    await transport.start();
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
      remote = next;
      remoteUrl = url;
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

  const forward = async (message: JSONRPCMessage) => {
    await switching;
    const target = remote;
    try {
      await target.send(message);
    } catch (err) {
      if (!reconnect) throw err;
      await switchServer(target);
      await remote.send(message);
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
    forward(message).catch(async (err: unknown) => {
      const failure = `Could not reach the evalution server at ${remoteUrl}: ${err instanceof Error ? err.message : String(err)}`;
      if (isJSONRPCRequest(message)) {
        await local
          .send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32603,
              message: `${failure}. Restart the evalution MCP server to reconnect.`,
            },
          })
          .catch(() => {});
      }
      end(failure);
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
