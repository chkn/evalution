// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * `evalution mcp` relaying to another process's `/mcp` endpoint, over real
 * HTTP on a loopback port: what's under test is exactly the hop
 * `InMemoryTransport` tests skip.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it } from "vitest";
import { type PromptProvider, promptIdOf } from "../prompt/prompt-provider.ts";
import { createProjectContext } from "../server/api-context.ts";
import type { NormalizedPrompt } from "../shared/types.ts";
import { runMigrations } from "../trace/db/migrate.ts";
import { TursoTraceProvider } from "../trace/turso-trace-provider.ts";
import {
  findOrBecomeHolder,
  type McpHttpServer,
  type RelayMcpOptions,
  relayMcp,
  serveMcpOverHttp,
} from "./mcp.ts";
import { serverInfoPath } from "./server-discovery.ts";

const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => {});
});

/** A prompt, `slow`, whose runs take `SLOW_MS` to finish. */
const SLOW_MS = 800;
const SLOW: NormalizedPrompt = {
  id: "slow",
  name: "slow",
  style: "chat",
  functionParameters: [],
  modelEditable: false,
  modelParameters: [],
  systemEditable: false,
  messages: [],
  messagesEditable: false,
};

function slowPrompts(traces: TursoTraceProvider): PromptProvider {
  return {
    id: "files",
    getAllPrompts: async () => [SLOW],
    getPrompt: async ref => (promptIdOf(ref) === SLOW.id ? SLOW : null),
    async execute(_ref, _params, options) {
      const traceId = options?.traceId as string;
      const span = {
        id: `${traceId}:root`,
        traceId,
        name: "slow",
        kind: "LLM" as const,
        startTime: 1,
      };
      await traces.recordSpanStart(span);
      setTimeout(async () => {
        // The test may be over, and its database closed, by now.
        await traces
          .recordSpanEnd({ ...span, endTime: 2, status: "ok" })
          .catch(() => {});
        options?.onSettled?.();
      }, SLOW_MS);
    },
  };
}

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
    promptProviders: [slowPrompts(traces)],
    traceProviders: [traces],
    rootPath: "/project",
  });
  const server = await serveMcpOverHttp(context, "0.0.0-test", true);
  cleanup.push(() => server.close());
  return server;
}

/** An agent connected through a relay to `server`; `ended` settles with the relay's failure, if any. */
async function relayedAgent(
  server: McpHttpServer,
  name: string,
  options?: RelayMcpOptions,
) {
  const [agentSide, relaySide] = InMemoryTransport.createLinkedPair();
  let ended!: Promise<string | undefined>;
  await new Promise<void>((started, failed) => {
    ended = new Promise(resolve => {
      relayMcp(relaySide, server.url, resolve, options).then(started, failed);
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

  it("moves to the server `reconnect` names once the first is gone, unnoticed by the agent", async () => {
    const first = await servedProject();
    const second = await servedProject();
    let reconnects = 0;
    const { agent } = await relayedAgent(first, "codex-mcp-client", {
      reconnect: async () => {
        reconnects++;
        return second.url;
      },
    });
    await agent.callTool({ name: "list_traces", arguments: {} });
    await first.close();

    const [a, b] = await Promise.all([
      agent.callTool({
        name: "create_annotation",
        arguments: { traceId: "t1", kind: "note", note: "after the switch" },
      }),
      agent.callTool({ name: "list_traces", arguments: {} }),
    ]);
    expect(JSON.parse(text(a)).source).toBe("codex");
    expect(b.isError).toBeFalsy();
    // Two failed sends, one switch.
    expect(reconnects).toBe(1);
  });

  it("is idle only once the requests it's answering are answered", async () => {
    const server = await servedProject();
    await server.idle();
    const { agent } = await relayedAgent(server, "zed");
    const started = Date.now();
    const call = agent.callTool({
      name: "execute_prompt",
      arguments: { promptId: "slow" },
    });
    await new Promise(r => setTimeout(r, SLOW_MS / 4));
    await server.idle();
    // Not before the run, and with it the response, was over.
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW_MS);
    expect((await call).isError).toBeFalsy();
  });

  it("answers a request in flight with an error when its server goes away, then moves on", async () => {
    const first = await servedProject();
    const second = await servedProject();
    const { agent } = await relayedAgent(first, "zed", {
      reconnect: async () => second.url,
    });
    await agent.callTool({ name: "list_traces", arguments: {} });
    const started = Date.now();
    const call = agent.callTool(
      { name: "execute_prompt", arguments: { promptId: "slow" } },
      { timeout: 10_000 },
    );
    await new Promise(r => setTimeout(r, SLOW_MS / 4));
    await first.close();
    await expect(call).rejects.toThrow(/went away while answering/);
    // Told at once, not after the client's own timeout.
    expect(Date.now() - started).toBeLessThan(SLOW_MS * 2);

    const after = await agent.callTool({ name: "list_traces", arguments: {} });
    expect(after.isError).toBeFalsy();
  });

  it("ends with an error when `reconnect` finds no server either", async () => {
    const server = await servedProject();
    const { agent, ended } = await relayedAgent(server, "zed", {
      reconnect: async () => {
        throw new Error("no holder");
      },
    });
    await agent.callTool({ name: "list_traces", arguments: {} });
    await server.close();
    await expect(
      agent.callTool({ name: "list_traces", arguments: {} }),
    ).rejects.toThrow(/no holder/);
    expect(await ended).toMatch(/no holder/);
  });
});

/** Real filesystem, deliberately: the claim is a file other processes read. */
describe("findOrBecomeHolder", () => {
  async function project(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "evalution-holder-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it("relays to the server running", async () => {
    const dir = await project();
    const url = await findOrBecomeHolder(
      dir,
      async () => {
        throw new Error("shouldn't become the holder");
      },
      {
        find: async () => ({ url: "http://127.0.0.1:9", pid: 1, kind: "ui" }),
      },
    );
    expect(url).toBe("http://127.0.0.1:9");
  });

  it("claims the project before becoming the holder when none is running", async () => {
    const dir = await project();
    const url = await findOrBecomeHolder(dir, async () => {
      // Claimed, though not listening yet.
      expect(JSON.parse(await readFile(serverInfoPath(dir), "utf8"))).toEqual({
        pid: process.pid,
        kind: "mcp",
      });
      return "http://127.0.0.1:9";
    });
    expect(url).toBe("http://127.0.0.1:9");
  });

  it("never becomes the holder while another live process has claimed the project", async () => {
    const dir = await project();
    await findOrBecomeHolder(dir, async () => "http://127.0.0.1:9");
    // The parent of this process: alive, and not this one.
    await writeFile(
      serverInfoPath(dir),
      JSON.stringify({ pid: process.ppid, kind: "mcp" }),
    );
    let became = false;
    await expect(
      findOrBecomeHolder(
        dir,
        async () => {
          became = true;
          return "http://127.0.0.1:9";
        },
        { find: async () => undefined },
      ),
    ).rejects.toThrow(/claimed it but isn't serving/);
    expect(became).toBe(false);
  });

  it("gives the claim back when becoming the holder fails", async () => {
    const dir = await project();
    await expect(
      findOrBecomeHolder(dir, async () => {
        throw new Error("bad config");
      }),
    ).rejects.toThrow(/bad config/);
    await expect(readFile(serverInfoPath(dir))).rejects.toThrow();
  });
});
