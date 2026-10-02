// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The `/mcp` endpoint: the API, as the MCP server in `../mcp/server.ts`
 * serves it, over streamable HTTP. An agent can connect to it directly, and
 * `evalution mcp` relays stdio to it when another process already holds the
 * project's databases.
 */

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type McpHttpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { createMcpServer, MCP_CLIENT_HEADER } from "../mcp/server.ts";
import type { ApiContext } from "./api-context.ts";

/** The `/mcp` endpoint {@link mountMcp} serves. */
export interface McpEndpoint extends McpHttpHandler {
  /** Resolves once no MCP request is being answered — its response streamed to the end. */
  idle(): Promise<void>;
}

/**
 * Serves `context` over MCP at `/mcp` on `app`. Returns the handler, for the
 * host to `close()` when it stops, and to wait on until it's `idle()`.
 *
 * Only requests addressed to localhost, from no page or a localhost one, get
 * through: a site the user visits can't drive the server through their
 * browser, even by DNS rebinding, and nothing reaching the machine over the
 * network can use it either.
 */
export function mountMcp(
  app: Hono,
  context: ApiContext,
  version: string,
): McpEndpoint {
  const mcp = createMcpHandler(
    ({ requestInfo }) =>
      createMcpServer(context, {
        version,
        clientName: requestInfo?.headers.get(MCP_CLIENT_HEADER) ?? undefined,
      }),
    { onerror: err => console.error("MCP error:", err) },
  );
  // Requests being answered — a tool call's response may stream for minutes.
  // GETs are left out: a standalone event stream never ends on its own.
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  const settle = () => {
    if (--inFlight === 0) for (const resolve of waiters.splice(0)) resolve();
  };
  const track = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return mcp.fetch(request);
    inFlight++;
    let response: Response;
    try {
      response = await mcp.fetch(request);
    } catch (err) {
      settle();
      throw err;
    }
    if (!response.body) {
      settle();
      return response;
    }
    const reader = response.body.getReader();
    let open = true;
    const finish = () => {
      if (open) {
        open = false;
        settle();
      }
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          finish();
          controller.error(err);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    });
    return new Response(body, response);
  };
  app.all(
    "/mcp",
    c =>
      hostHeaderValidationResponse(c.req.raw, localhostAllowedHostnames()) ??
      originValidationResponse(c.req.raw, localhostAllowedOrigins()) ??
      track(c.req.raw),
  );
  return Object.assign(mcp, {
    idle: () =>
      inFlight === 0
        ? Promise.resolve()
        : new Promise<void>(resolve => waiters.push(resolve)),
  });
}
