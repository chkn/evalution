// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import net from "node:net";
import { fileURLToPath } from "node:url";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import type { DatasetProvider } from "../dataset/dataset-provider.ts";
import type { EvalProvider } from "../eval/eval-provider.ts";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import type { SSEData } from "../shared/types.ts";
import type { OtlpTraceIngestor } from "../trace/otlp-trace-ingestor.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import { buildAskAgentCommand, listAgents } from "./agents.ts";
import { createProjectContext } from "./api-context.ts";
import { type AgentHandlers, setupRoutes } from "./api-routes.ts";
import { DEFAULT_HOST, serverUrl } from "./listen-address.ts";
import { mountMcp } from "./mcp-route.ts";
import { requestGuard } from "./request-guard.ts";
import { executeSetupStep, resolveSetupTasks } from "./setup-tasks.ts";
import {
  registerTerminalRoute,
  resolveSetupStepCommand,
  type TerminalSessionRegistry,
} from "./terminal.ts";

export interface ServerOptions {
  promptProviders: PromptProvider[];
  traceProviders: TraceProvider[];
  /** Dataset stores. Defaults to none. */
  datasetProviders?: DatasetProvider[];
  /** Eval stores. Defaults to none. */
  evalProviders?: EvalProvider[];
  port: number;
  /**
   * The address to listen on. Defaults to {@link DEFAULT_HOST}, loopback
   * only; `0.0.0.0` (or `::`) makes the server reachable from the network.
   */
  hostname?: string;
  /**
   * Where users open the playground when a proxy in front of the server
   * serves it under another URL, e.g. portless's `PORTLESS_URL`
   * (`https://evalution.myapp.localhost`). Printed in place of the server's
   * own URL, and its hostname is accepted in `Host` and `Origin`.
   */
  publicUrl?: string;
  rootPath: string;
  /** Whether the server was started with a project config file loaded. */
  hasConfig: boolean;
  /**
   * Live onboarding-terminal sessions. Owned by the caller (the CLI) rather
   * than created here, so PTYs survive the restart this server performs once a
   * config file appears.
   */
  terminalSessions: TerminalSessionRegistry;
  /**
   * The process's OTLP ingestor, if any. When set, external apps can export
   * traces to this server over `POST /v1/traces`. See
   * `SetupRoutesOptions.otlpIngestor`.
   */
  otlpIngestor?: OtlpTraceIngestor;
  /** This package's version, reported to MCP clients. */
  version: string;
}

/** A running server, returned by {@link startServer}. */
export interface ServerHandle {
  /** The URL the server is listening on, e.g. `http://localhost:3000`. */
  url: string;
  /** The URL to open the playground at: `publicUrl` if given, else {@link url}. */
  publicUrl: string;
  /**
   * Stops the server, force-closing any open connections (including live SSE
   * streams) so it shuts down promptly instead of waiting on them. Used by the
   * CLI to restart cleanly once a config file appears.
   */
  close: () => Promise<void>;
}

export async function startServer(
  options: ServerOptions,
): Promise<ServerHandle> {
  const {
    promptProviders,
    traceProviders,
    datasetProviders = [],
    evalProviders = [],
    port,
    hostname = DEFAULT_HOST,
    publicUrl: givenPublicUrl,
    rootPath,
    hasConfig,
    terminalSessions,
    otlpIngestor,
    version,
  } = options;

  // Hot-reload SSE subscribers. Each `/api/events` connection registers a
  // writer here; `broadcast` fans an event out to all of them.
  const hotReloadSubscribers = new Set<(data: SSEData) => void>();
  const broadcast = (data: SSEData) => {
    for (const send of hotReloadSubscribers) send(data);
  };

  // Each prompt provider's SDK adapter already ran its own `setupTraceIngestion`
  // (registering a native v7 integration, or standing up the global OTel
  // tracer provider + context manager for v6) during `startConfiguredServer`,
  // before this function was called — so the global tracer provider the
  // context traces with, if any, is already in place.
  const context = await createProjectContext({
    promptProviders,
    traceProviders,
    datasetProviders,
    evalProviders,
    rootPath,
    onPromptChanged: (providerId, event) =>
      broadcast({ type: "prompt-changed", providerId, event }),
  });

  // Launched agents connect back to this server's own MCP endpoint (below).
  const url = serverUrl(hostname, port);
  const agents: AgentHandlers = {
    list: listAgents,
    command: (agentId, agentContext) =>
      buildAskAgentCommand(context, `${url}/mcp`, agentId, agentContext),
  };

  const publicUrl = givenPublicUrl ?? url;

  const app = new Hono();
  // Ahead of every route: other websites can send this unauthenticated server
  // requests, and must be refused. See `./request-guard.ts`.
  app.use(
    requestGuard({
      allowedHosts: [
        new URL(publicUrl).hostname,
        // A name `--host` was given, e.g. `devbox.local`.
        ...(net.isIP(hostname) ? [] : [hostname]),
      ],
    }),
  );
  setupRoutes({
    app,
    context,
    hotReloadSubscribers,
    hasConfig,
    setupTasks: { resolve: resolveSetupTasks, executeStep: executeSetupStep },
    agents,
    otlpIngestor,
  });

  // The same API over MCP (streamable HTTP), for an agent to connect to — or
  // for `evalution mcp` to relay stdio to, since this process holds the
  // project's databases.
  const mcp = mountMcp(app, context, version);

  // Interactive terminal for onboarding `run_command`/`install_package` steps
  // and launched coding agents. Registered before the static catch-all so the
  // upgrade request is routed.
  registerTerminalRoute(
    app,
    upgradeWebSocket,
    rootPath,
    terminalSessions,
    async target =>
      target.kind === "setup"
        ? resolveSetupStepCommand(target.taskId, target.stepId)
        : agents.command(target.agentId, target.context),
  );

  // Serve the built client. `serveStatic`'s root is resolved against
  // `process.cwd()`, which the CLI changes to the user's project, so anchor it
  // to this module instead. Registered as a catch-all after the API routes.
  const clientRoot = fileURLToPath(new URL("../client/", import.meta.url));
  app.get("*", serveStatic({ root: clientRoot }));

  // Forward trace change events to SSE clients
  for (const [providerId, provider] of context.traceProviders) {
    if (provider.watch) {
      provider.watch(event => {
        broadcast({ type: "trace-changed", providerId, event });
      });
    }
  }

  // Start server. `noServer: true` lets @hono/node-server own the HTTP upgrade
  // handshake and hand matching requests to the WebSocket routes above.
  const wss = new WebSocketServer({ noServer: true });

  // When running from a bundled build the client is served by this process;
  // when running from source (`npm run dev`) the client lives on a separate
  // Vite dev server. Key off the module path rather than `NODE_ENV`, which
  // isn't set under `npx evalution`.
  const isDevServer = import.meta.url.includes("/src/");

  const server = await new Promise<ReturnType<typeof serve>>(
    (resolve, reject) => {
      const s = serve(
        {
          fetch: app.fetch,
          port,
          hostname,
          websocket: { server: wss },
        },
        () => {
          if (isDevServer) {
            console.log(`\n✨ Evalution API server running on ${url}`);
            console.log(`   Frontend dev server: http://localhost:5173\n`);
          } else {
            console.log(`\n✨ Evalution is running at ${publicUrl}\n`);
          }
          s.off("error", reject);
          resolve(s);
        },
      );
      // Can't listen — e.g. `--host` names no local address, or `PORT` is taken.
      s.once("error", reject);
    },
  );

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      // Drop open connections up front, or `close` would wait on them forever.
      // `closeAllConnections` handles plain HTTP connections (notably long-lived
      // SSE streams) but NOT upgraded WebSockets — once a socket is handed to
      // `ws` via `handleUpgrade` the HTTP server no longer tracks it — so those
      // must be closed explicitly via `wss.clients`. Closing them gracefully
      // fires each session's `onClose`, which starts the reconnect grace window
      // instead of killing the PTY, so a running coding agent survives the
      // restart and the reconnecting client resumes it.
      for (const ws of wss.clients) ws.close();
      void mcp.close();
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
      server.close(err => (err ? reject(err) : resolve()));
    });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n\nShutting down gracefully...");
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { url, publicUrl, close };
}
