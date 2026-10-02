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

/**
 * Serves `context` over MCP at `/mcp` on `app`. Returns the handler, for the
 * host to `close()` when it stops.
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
): McpHttpHandler {
  const mcp = createMcpHandler(
    ({ requestInfo }) =>
      createMcpServer(context, {
        version,
        clientName: requestInfo?.headers.get(MCP_CLIENT_HEADER) ?? undefined,
      }),
    { onerror: err => console.error("MCP error:", err) },
  );
  app.all(
    "/mcp",
    c =>
      hostHeaderValidationResponse(c.req.raw, localhostAllowedHostnames()) ??
      originValidationResponse(c.req.raw, localhostAllowedOrigins()) ??
      mcp.fetch(c.req.raw),
  );
  return mcp;
}
