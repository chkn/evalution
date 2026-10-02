// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * `evalution mcp`: serves the project's API as an MCP server over stdio, for
 * a coding agent to launch (`npx evalution mcp`).
 *
 * A project's trace and dataset databases can be held open by one process at
 * a time, so when `evalution ui` is already serving the project this doesn't
 * open them a second time: it relays stdio to that server's `/mcp` endpoint
 * instead, and annotations an agent leaves show up live in the open UI.
 * Otherwise it serves in-process.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { trace } from "@opentelemetry/api";
import { createMcpServer } from "../mcp/server.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import { createApiContext } from "../server/api-context.ts";
import type { ProjectProviders } from "./project.ts";

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

/** Serves `providers` over stdio, in this process. */
export async function serveMcpInProcess(
  rootPath: string,
  providers: ProjectProviders,
  version: string,
): Promise<void> {
  const { promptProviders, traceProviders, datasetProviders } = providers;
  const promptProviderMap = new Map(promptProviders.map(p => [p.id, p]));
  const traceProviderMap = new Map(traceProviders.map(p => [p.id, p]));
  const defaultTraceProvider = traceProviders[0];
  if (!defaultTraceProvider) {
    throw new Error("At least one trace provider must be configured");
  }

  // As the UI server does: keep the registry current, so prompt links in
  // traces and datasets resolve to wherever the prompt lives now.
  const promptRegistry = new PromptRegistry();
  await promptRegistry.rebuild(promptProviderMap);
  for (const provider of promptProviders) {
    provider.watch?.(() => void promptRegistry.rebuild(promptProviderMap));
  }

  const context = createApiContext({
    promptProviders: promptProviderMap,
    traceProviders: traceProviderMap,
    datasetProviders: new Map(datasetProviders.map(p => [p.id, p])),
    promptRegistry,
    rootPath,
    // As in the UI server: whatever tracer an SDK adapter registered.
    tracer: trace.getTracer("evalution"),
    defaultTraceProviderId: defaultTraceProvider.id,
  });
  serveStdio(() => createMcpServer(context, { version }), {
    onerror: err => console.error("MCP error:", err),
  });
  exitWithStdin();
  console.error(`✨ Evalution MCP server running for ${rootPath}`);
}

/**
 * Relays MCP messages between stdio and the `/mcp` endpoint of the UI server
 * at `serverUrl`, message for message.
 */
export async function relayMcpToServer(serverUrl: string): Promise<void> {
  const stdio = new StdioServerTransport();
  const http = new StreamableHTTPClientTransport(new URL("/mcp", serverUrl));
  stdio.onmessage = message => {
    http.send(message).catch(err => {
      console.error(`Could not reach ${serverUrl}/mcp:`, err);
    });
  };
  http.onmessage = message => void stdio.send(message);
  http.onerror = err => console.error("MCP relay error:", err);
  stdio.onclose = () => process.exit(0);
  // The UI server going away ends the relay too: there's nothing left to
  // answer, and the agent will restart this process when it next needs it.
  http.onclose = () => process.exit(0);
  await http.start();
  await stdio.start();
  exitWithStdin();
  console.error(`✨ Evalution MCP relaying to the running UI at ${serverUrl}`);
}
