// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * `evalution mcp`: serves the project's API as an MCP server over stdio, for
 * a coding agent to launch (`npx evalution mcp`).
 *
 * A project's trace and dataset databases can be held open by one process at
 * a time. So the first process to serve a project — `evalution ui`, or an
 * `evalution mcp` with nothing else running — holds them, and also serves
 * MCP over HTTP and records where (see `./server-discovery.ts`). Every
 * `evalution mcp` started after it relays stdio to that endpoint instead of
 * opening the databases a second time: several agent sessions on one
 * project share the first one's server, and annotations they leave show up
 * live in an open UI.
 */

import { serve } from "@hono/node-server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  isJSONRPCRequest,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { Hono } from "hono";
import { createMcpServer, MCP_CLIENT_HEADER } from "../mcp/server.ts";
import {
  type ApiContext,
  createProjectContext,
} from "../server/api-context.ts";
import { mountMcp } from "../server/mcp-route.ts";
import type { ProjectProviders } from "./project.ts";
import { writeServerInfo } from "./server-discovery.ts";

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

/** Exits once the client closes stdin — file watchers would otherwise keep the process alive. */
function exitWithStdin(): void {
  const exit = () => process.exit(0);
  process.stdin.once("end", exit);
  process.stdin.once("close", exit);
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
 * later `evalution mcp` needs to relay to this process.
 */
export async function serveMcpOverHttp(
  context: ApiContext,
  version: string,
): Promise<McpHttpServer> {
  const app = new Hono();
  app.get("/api/config", c => c.json({ rootPath: context.rootPath }));
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

/**
 * Serves `providers` over stdio, in this process, and over HTTP for any
 * `evalution mcp` started for the project after it.
 */
export async function serveMcpInProcess(
  rootPath: string,
  providers: ProjectProviders,
  version: string,
): Promise<void> {
  const context = await createProjectContext({ ...providers, rootPath });
  serveStdio(() => createMcpServer(context, { version }), {
    onerror: err => console.error("MCP error:", err),
  });
  exitWithStdin();
  const http = await serveMcpOverHttp(context, version);
  await writeServerInfo(rootPath, http.url, "mcp");
  console.error(`✨ Evalution MCP server running for ${rootPath}`);
}

/**
 * Relays MCP messages between `local` (the agent's side) and the `/mcp`
 * endpoint of the server at `serverUrl`, message for message, until either
 * side goes away; then calls `onEnd` — with why, if it's because the server
 * couldn't be reached.
 *
 * A request the server can't be reached for is answered with an error
 * rather than left hanging, and ends the relay: the agent then restarts
 * `evalution mcp`, which serves in-process or finds whichever server is
 * running now.
 */
export async function relayMcp(
  local: Transport,
  serverUrl: string,
  onEnd: (failure?: string) => void,
): Promise<void> {
  // A 2025-era client is served statelessly over HTTP, so the server never
  // sees its `initialize`; pass its name along on every request instead.
  let clientName: string | undefined;
  const remote = new StreamableHTTPClientTransport(new URL("/mcp", serverUrl), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (clientName) headers.set(MCP_CLIENT_HEADER, clientName);
      return fetch(url, { ...init, headers });
    },
  });

  let ended = false;
  const end = (failure?: string) => {
    if (ended) return;
    ended = true;
    void remote.close().catch(() => {});
    void local.close().catch(() => {});
    onEnd(failure);
  };

  local.onmessage = (message: JSONRPCMessage) => {
    if (isJSONRPCRequest(message) && message.method === "initialize") {
      const info = (message.params as { clientInfo?: { name?: unknown } })
        ?.clientInfo;
      if (typeof info?.name === "string") clientName = info.name;
    }
    remote.send(message).catch(async (err: unknown) => {
      const failure = `Could not reach the evalution server at ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`;
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
  remote.onmessage = message => void local.send(message);
  remote.onerror = err => console.error("MCP relay error:", err);
  local.onclose = () => end();
  remote.onclose = () => end(`The evalution server at ${serverUrl} closed`);
  await remote.start();
  await local.start();
}

/** Relays stdio to the server at `serverUrl` — see {@link relayMcp} — exiting when the relay ends. */
export async function relayMcpToServer(serverUrl: string): Promise<void> {
  await relayMcp(new StdioServerTransport(), serverUrl, failure => {
    if (failure) console.error(failure);
    process.exit(failure ? 1 : 0);
  });
  exitWithStdin();
  console.error(`✨ Evalution MCP relaying to ${serverUrl}`);
}
