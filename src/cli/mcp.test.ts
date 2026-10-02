// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * `evalution mcp` relaying to another process's `/mcp` endpoint, over real
 * HTTP on a loopback port: what's under test is exactly the hop
 * `InMemoryTransport` tests skip.
 */

import { request } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectContext } from "../server/api-context.ts";
import { runMigrations } from "../trace/db/migrate.ts";
import { TursoTraceProvider } from "../trace/turso-trace-provider.ts";
import { type McpHttpServer, relayMcp, serveMcpOverHttp } from "./mcp.ts";

const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => {});
});

/** A project with one trace, `t1`, served over HTTP the way the first process serves it. */
async function servedProject(): Promise<McpHttpServer> {
  const client: Database = await connect({ path: ":memory:", url: () => null });
  cleanup.push(() => client.close());
  await runMigrations(drizzle({ client }));
  const traces = new TursoTraceProvider({ client, id: "local" });
  await traces.recordSpanStart({
    id: "t1:root",
    traceId: "t1",
    name: "root",
    kind: "LLM",
    startTime: 1,
  });
  const context = await createProjectContext({
    promptProviders: [],
    traceProviders: [traces],
    rootPath: "/project",
  });
  const server = await serveMcpOverHttp(context, "0.0.0-test", true);
  cleanup.push(() => server.close());
  return server;
}

/** An agent connected through a relay to `server`; `ended` settles with the relay's failure, if any. */
async function relayedAgent(server: McpHttpServer, name: string) {
  const [agentSide, relaySide] = InMemoryTransport.createLinkedPair();
  let ended!: Promise<string | undefined>;
  await new Promise<void>((started, failed) => {
    ended = new Promise(resolve => {
      relayMcp(relaySide, server.url, resolve).then(started, failed);
    });
  });
  const agent = new Client({ name, version: "1.0.0" });
  await agent.connect(agentSide);
  cleanup.push(() => agent.close());
  return { agent, ended };
}

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

describe("serveMcpOverHttp and relayMcp", () => {
  it("answers the config check a later `evalution mcp` makes", async () => {
    const server = await servedProject();
    const res = await fetch(`${server.url}/api/config`);
    expect(await res.json()).toEqual({
      rootPath: "/project",
      configured: true,
    });
  });

  it("refuses requests addressed to anything but localhost", async () => {
    const server = await servedProject();
    // `fetch` won't send a Host header of its own choosing; `http` will.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${server.url}/mcp`,
        {
          method: "POST",
          headers: { host: "evil.example", "content-type": "application/json" },
        },
        res => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });

  it("relays tool calls, attributing annotations to the agent behind the relay", async () => {
    const server = await servedProject();
    for (const [name, source] of [
      ["codex-mcp-client", "codex"],
      ["claude-code", "claude-code"],
      ["zed", "agent"],
    ]) {
      const { agent } = await relayedAgent(server, name);
      const created = JSON.parse(
        text(
          await agent.callTool({
            name: "create_annotation",
            arguments: { traceId: "t1", kind: "note", note: `from ${name}` },
          }),
        ),
      );
      expect(created.source).toBe(source);
    }
  });

  it("answers with an error, and ends, once the server is gone", async () => {
    const server = await servedProject();
    const { agent, ended } = await relayedAgent(server, "codex-mcp-client");
    await agent.callTool({ name: "list_traces", arguments: {} });
    await server.close();

    await expect(
      agent.callTool({ name: "list_traces", arguments: {} }),
    ).rejects.toThrow(/Could not reach the evalution server/);
    expect(await ended).toMatch(/Could not reach the evalution server/);
  });
});
